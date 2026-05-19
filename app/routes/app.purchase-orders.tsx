import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, Link } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, IndexTable, Badge, Button, Banner, InlineStack, TextField, FormLayout, Select, Modal, Box, Combobox, Listbox, Checkbox } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback } from "react";
import { pushPOToOdoo, pullOdooReceiving, cancelOdooPO, testOdooConnection } from "../services/odoo.server";

// Helper: verify manager PIN
function verifyManagerPin(config: any, pin: string, managerName?: string): { valid: boolean; name: string } {
  if (config?.masterOverridePin && pin === config.masterOverridePin) {
    return { valid: true, name: 'Owner' };
  }
  const delegated = JSON.parse(config?.delegatedManagerPins || '{}');
  for (const [name, mPin] of Object.entries(delegated)) {
    if (mPin === pin) return { valid: true, name };
  }
  return { valid: false, name: '' };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const config = await prisma.appConfiguration.findUnique({ where: { shop } });

  // Detect current user
  let currentUser = 'Owner';
  try {
    const onlineUser = (session as any).onlineAccessInfo?.associated_user;
    if (onlineUser) currentUser = `${onlineUser.first_name} ${onlineUser.last_name}`.trim();
  } catch (e) {}

  // Authorization gate: check if user is in poViewStaff
  const poViewStaff: string[] = JSON.parse(config?.poViewStaff || '[]');
  const poAuthorizedStaff: string[] = JSON.parse(config?.poAuthorizedStaff || '[]');
  // Owner always has access; if no staff configured yet, allow all (first-run)
  const isOwner = currentUser === 'Owner';
  const canView = isOwner || poViewStaff.length === 0 || poViewStaff.includes(currentUser);
  const canCreate = isOwner || poAuthorizedStaff.length === 0 || poAuthorizedStaff.includes(currentUser);

  if (!canView) {
    return json({ unauthorized: true, purchaseOrders: [], suppliers: [], variants: [], nextPoNumber: '', config: null, currentUser, canCreate: false });
  }

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where: { shop },
    include: { supplier: true, lineItems: true },
    orderBy: { createdAt: 'desc' }
  });

  const suppliers = await prisma.supplier.findMany({ where: { shop }, orderBy: { name: 'asc' } });

  const prodRes = await admin.graphql(`query { products(first: 50, query: "status:active") { edges { node { title variants(first: 10) { edges { node { id title sku inventoryItem { id } } } } } } } }`);
  const prodData = await prodRes.json();
  const variants: any[] = [];
  for (const p of (prodData.data?.products?.edges || [])) {
    for (const v of (p.node.variants.edges || [])) {
      if (v.node.inventoryItem?.id) {
        const skuStr = v.node.sku ? ` (SKU: ${v.node.sku})` : '';
        variants.push({
          label: `${p.node.title}${v.node.title !== 'Default Title' ? ` - ${v.node.title}` : ''}${skuStr}`,
          value: v.node.inventoryItem.id.replace('gid://shopify/InventoryItem/', ''),
          sku: v.node.sku || ''
        });
      }
    }
  }

  const year = new Date().getFullYear();
  const lastPO = await prisma.purchaseOrder.findFirst({
    where: { shop, poNumber: { startsWith: `PO-${year}-` } },
    orderBy: { poNumber: 'desc' }
  });
  const nextSeq = lastPO ? parseInt(lastPO.poNumber.split('-')[2], 10) + 1 : 1;
  const nextPoNumber = `PO-${year}-${nextSeq.toString().padStart(4, '0')}`;

  return json({ purchaseOrders, suppliers, variants, nextPoNumber, config, currentUser, canCreate });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "createSupplier") {
    const name = formData.get("name") as string;
    const email = formData.get("email") as string;
    const contactName = formData.get("contactName") as string;
    const phone = formData.get("phone") as string;
    const leadTime = parseInt(formData.get("leadTimeDays") as string, 10) || 14;
    await prisma.supplier.create({ data: { shop, name, email: email || null, contactName: contactName || null, phone: phone || null, leadTimeDays: leadTime } });
    return json({ success: true });
  }

  if (actionType === "createPO") {
    // Authorization check: only poAuthorizedStaff can create
    const config = await prisma.appConfiguration.findUnique({ where: { shop } });
    const authorized: string[] = JSON.parse(config?.poAuthorizedStaff || '[]');
    const createdBy = formData.get("createdBy") as string || "Owner";
    if (authorized.length > 0 && !authorized.includes(createdBy) && createdBy !== 'Owner') {
      return json({ error: "You are not authorized to create purchase orders." }, { status: 403 });
    }

    const poNumber = formData.get("poNumber") as string;
    const supplierId = formData.get("supplierId") as string;
    const notes = formData.get("notes") as string;
    const expectedDate = formData.get("expectedDate") as string;
    const lineItemsJson = formData.get("lineItems") as string;
    const lineItems = JSON.parse(lineItemsJson || "[]");

    let totalCost = 0; let totalUnits = 0;
    for (const li of lineItems) { totalCost += (li.qty * li.cost); totalUnits += li.qty; }

    await prisma.purchaseOrder.create({
      data: {
        shop, poNumber, supplierId, createdBy, notes: notes || null,
        expectedDate: expectedDate ? new Date(expectedDate) : null,
        totalCost, totalUnits,
        lineItems: {
          create: lineItems.map((li: any) => ({
            inventoryItemId: li.inventoryItemId, productName: li.productName,
            sku: li.sku || null, orderedQty: li.qty, unitCost: li.cost
          }))
        }
      }
    });
    return json({ success: true });
  }

  if (actionType === "updateStatus") {
    // PIN required for close/cancel
    const poId = formData.get("poId") as string;
    const status = formData.get("status") as string;
    const pin = formData.get("pin") as string;
    const config = await prisma.appConfiguration.findUnique({ where: { shop } });
    if (['closed', 'cancelled'].includes(status)) {
      const pinCheck = verifyManagerPin(config, pin);
      if (!pinCheck.valid) return json({ error: "Invalid manager PIN." }, { status: 403 });
      await prisma.purchaseOrder.update({ where: { id: poId }, data: { status, approvedBy: pinCheck.name } });
    } else {
      await prisma.purchaseOrder.update({ where: { id: poId }, data: { status } });
    }
    return json({ success: true });
  }

  if (actionType === "approveSendPO") {
    // Manager PIN required to approve and send
    const poId = formData.get("poId") as string;
    const pin = formData.get("pin") as string;
    const config = await prisma.appConfiguration.findUnique({ where: { shop } });
    const pinCheck = verifyManagerPin(config, pin);
    if (!pinCheck.valid) return json({ error: "Invalid manager PIN. Only managers can approve purchase orders." }, { status: 403 });

    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId }, include: { supplier: true, lineItems: true } });
    if (!po || !po.supplier.email) return json({ error: "No supplier email" }, { status: 400 });

    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY || "re_12345");

    const logoHtml = config?.companyLogo ? `<img src="${config.companyLogo}" alt="Logo" style="max-height:80px;margin-bottom:16px;" />` : '';
    const companyBlock = `
      ${logoHtml}
      <h1 style="margin:0;font-size:24px;color:#1a1a2e;">Purchase Order: ${po.poNumber}</h1>
      ${config?.companyName ? `<p style="margin:4px 0;font-weight:bold;">${config.companyName}</p>` : ''}
      ${config?.companyAddress ? `<p style="margin:2px 0;color:#666;">${config.companyAddress}</p>` : ''}
      ${config?.companyPhone ? `<p style="margin:2px 0;color:#666;">Phone: ${config.companyPhone}</p>` : ''}
      ${config?.companyEmail ? `<p style="margin:2px 0;color:#666;">Email: ${config.companyEmail}</p>` : ''}
    `;

    const lineItemRows = po.lineItems.map(li =>
      `<tr><td style="padding:8px;border:1px solid #ddd;">${li.productName}</td><td style="padding:8px;border:1px solid #ddd;">${li.sku || '—'}</td><td style="padding:8px;border:1px solid #ddd;text-align:center;">${li.orderedQty}</td><td style="padding:8px;border:1px solid #ddd;text-align:right;">$${li.unitCost.toFixed(2)}</td><td style="padding:8px;border:1px solid #ddd;text-align:right;">$${(li.orderedQty * li.unitCost).toFixed(2)}</td></tr>`
    ).join('');

    await resend.emails.send({
      from: "Purchase Orders <onboarding@resend.dev>",
      to: [po.supplier.email],
      subject: `Purchase Order ${po.poNumber} from ${config?.companyName || shop}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:24px;">
        ${companyBlock}
        <hr style="margin:16px 0;border:1px solid #eee;" />
        <p><strong>Supplier:</strong> ${po.supplier.name}</p>
        ${po.supplier.contactName ? `<p><strong>Attn:</strong> ${po.supplier.contactName}</p>` : ''}
        ${po.expectedDate ? `<p><strong>Expected Delivery:</strong> ${new Date(po.expectedDate).toLocaleDateString()}</p>` : ''}
        ${po.notes ? `<p><strong>Notes:</strong> ${po.notes}</p>` : ''}
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <thead><tr style="background:#f4f4f4;">
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Product</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">SKU</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:center;">Qty</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:right;">Unit Cost</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:right;">Total</th>
          </tr></thead>
          <tbody>${lineItemRows}</tbody>
          <tfoot><tr style="background:#f4f4f4;font-weight:bold;">
            <td colspan="2" style="padding:8px;border:1px solid #ddd;">Total</td>
            <td style="padding:8px;border:1px solid #ddd;text-align:center;">${po.totalUnits}</td>
            <td style="padding:8px;border:1px solid #ddd;"></td>
            <td style="padding:8px;border:1px solid #ddd;text-align:right;">$${po.totalCost.toFixed(2)}</td>
          </tr></tfoot>
        </table>
        <p style="margin-top:24px;color:#888;font-size:12px;">Generated by ONIT Inventory Protection Suite</p>
      </div>`
    });

    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: { status: "sent", approvedBy: pinCheck.name, approvedAt: new Date() }
    });

    // Auto-push to Odoo if enabled
    if (config?.odooEnabled && config.odooUrl && config.odooDatabase && config.odooApiKey) {
      const odooConfig = {
        odooUrl: config.odooUrl,
        odooDatabase: config.odooDatabase,
        odooApiKey: config.odooApiKey,
        odooUserId: config.odooUserId
      };
      // Fire and forget — don't block the response
      pushPOToOdoo(shop, poId, odooConfig).catch(err => console.error('[Odoo] Background push failed:', err));
    }

    return json({ success: true });
  }

  if (actionType === "deletePO") {
    const poId = formData.get("poId") as string;
    await prisma.purchaseOrder.delete({ where: { id: poId } });
    return json({ success: true });
  }

  if (actionType === "updateCompanyInfo") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: {
        companyName: formData.get("companyName") as string || null,
        companyAddress: formData.get("companyAddress") as string || null,
        companyPhone: formData.get("companyPhone") as string || null,
        companyEmail: formData.get("companyEmail") as string || null,
        companyLogo: formData.get("companyLogo") as string || null,
      }
    });
    return json({ success: true });
  }

  if (actionType === "odooSync") {
    const poId = formData.get("poId") as string;
    const syncAction = formData.get("syncAction") as string; // "push", "pull", "cancel"
    const config = await prisma.appConfiguration.findUnique({ where: { shop } });
    if (!config?.odooEnabled || !config.odooUrl || !config.odooDatabase || !config.odooApiKey) {
      return json({ error: "Odoo integration is not configured" }, { status: 400 });
    }
    const odooConfig = {
      odooUrl: config.odooUrl,
      odooDatabase: config.odooDatabase,
      odooApiKey: config.odooApiKey,
      odooUserId: config.odooUserId
    };
    if (syncAction === 'push') {
      const result = await pushPOToOdoo(shop, poId, odooConfig);
      return json(result);
    } else if (syncAction === 'pull') {
      const result = await pullOdooReceiving(shop, poId, odooConfig);
      return json(result);
    } else if (syncAction === 'cancel') {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
      if (po?.odooPOId) await cancelOdooPO(odooConfig, po.odooPOId);
      return json({ success: true });
    }
  }

  if (actionType === "testOdoo") {
    const url = formData.get("odooUrl") as string;
    const db = formData.get("odooDatabase") as string;
    const key = formData.get("odooApiKey") as string;
    const result = await testOdooConnection(url, db, key);
    if (result.success && result.userId) {
      await prisma.appConfiguration.update({
        where: { shop },
        data: { odooUserId: result.userId }
      });
    }
    return json(result);
  }

  if (actionType === "saveOdooConfig") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: {
        odooEnabled: formData.get("odooEnabled") === "true",
        odooUrl: formData.get("odooUrl") as string || null,
        odooDatabase: formData.get("odooDatabase") as string || null,
        odooApiKey: formData.get("odooApiKey") as string || null,
      }
    });
    return json({ success: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: any; label: string }> = {
    draft: { tone: "info", label: "Draft" },
    sent: { tone: "attention", label: "Sent" },
    partially_received: { tone: "warning", label: "Partial" },
    received: { tone: "success", label: "Received" },
    closed: { tone: "success", label: "Closed" },
    cancelled: { tone: "critical", label: "Cancelled" },
  };
  const m = map[status] || { tone: "info", label: status };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export default function PurchaseOrders() {
  const data = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const isLoading = nav.state !== "idle";

  // Authorization gate
  if ('unauthorized' in data && data.unauthorized) {
    return (
      <Page title="📋 Purchase Orders">
        <Layout><Layout.Section>
          <Banner tone="critical"><p>You are not authorized to view purchase orders. Contact your administrator to request access.</p></Banner>
        </Layout.Section></Layout>
      </Page>
    );
  }

  const { purchaseOrders, suppliers, variants, nextPoNumber, config, currentUser, canCreate } = data as any;

  // PIN modal state
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinValue, setPinValue] = useState("");
  const [pinAction, setPinAction] = useState<{ type: string; poId: string; status?: string } | null>(null);
  const [pinError, setPinError] = useState("");

  // Odoo Integration state
  const [showOdoo, setShowOdoo] = useState(false);
  const [odooEnabled, setOdooEnabled] = useState(config?.odooEnabled || false);
  const [odooUrl, setOdooUrl] = useState(config?.odooUrl || "");
  const [odooDatabase, setOdooDatabase] = useState(config?.odooDatabase || "");
  const [odooApiKey, setOdooApiKey] = useState(config?.odooApiKey || "");
  const [odooTestResult, setOdooTestResult] = useState<string | null>(null);

  // Create PO state
  const [showCreate, setShowCreate] = useState(false);
  const [poSupplierId, setPoSupplierId] = useState("");
  const [poNotes, setPoNotes] = useState("");
  const [poExpectedDate, setPoExpectedDate] = useState("");
  const [lineItems, setLineItems] = useState<{ inventoryItemId: string; productName: string; sku: string; qty: number; cost: number }[]>([]);
  const [liProductInput, setLiProductInput] = useState("");
  const [liProductOptions, setLiProductOptions] = useState(variants);
  const [liProductId, setLiProductId] = useState("");
  const [liProductName, setLiProductName] = useState("");
  const [liSku, setLiSku] = useState("");
  const [liQty, setLiQty] = useState("1");
  const [liCost, setLiCost] = useState("0");

  // Create Supplier state
  const [showSupplier, setShowSupplier] = useState(false);
  const [supName, setSupName] = useState("");
  const [supEmail, setSupEmail] = useState("");
  const [supContact, setSupContact] = useState("");
  const [supPhone, setSupPhone] = useState("");
  const [supLeadTime, setSupLeadTime] = useState("14");

  // Company Info state
  const [showCompanyInfo, setShowCompanyInfo] = useState(false);
  const [companyName, setCompanyName] = useState(config?.companyName || "");
  const [companyAddress, setCompanyAddress] = useState(config?.companyAddress || "");
  const [companyPhone, setCompanyPhone] = useState(config?.companyPhone || "");
  const [companyEmail, setCompanyEmail] = useState(config?.companyEmail || "");
  const [companyLogo, setCompanyLogo] = useState(config?.companyLogo || "");

  const updateLiProduct = useCallback((value: string) => {
    setLiProductInput(value);
    if (!value) { setLiProductOptions(variants); return; }
    const re = new RegExp(value, 'i');
    setLiProductOptions(variants.filter((v: any) => v.label.match(re)));
  }, [variants]);

  const addLineItem = () => {
    if (!liProductId || !liQty) return;
    setLineItems([...lineItems, { inventoryItemId: liProductId, productName: liProductName, sku: liSku, qty: parseInt(liQty, 10), cost: parseFloat(liCost) || 0 }]);
    setLiProductId(""); setLiProductName(""); setLiSku(""); setLiProductInput(""); setLiQty("1"); setLiCost("0");
  };

  const handleCreatePO = () => {
    if (!poSupplierId || lineItems.length === 0) return;
    const fd = new FormData();
    fd.append("actionType", "createPO");
    fd.append("poNumber", nextPoNumber);
    fd.append("supplierId", poSupplierId);
    fd.append("createdBy", currentUser);
    fd.append("notes", poNotes);
    fd.append("expectedDate", poExpectedDate);
    fd.append("lineItems", JSON.stringify(lineItems));
    submit(fd, { method: "post" });
    setShowCreate(false); setLineItems([]); setPoNotes(""); setPoExpectedDate("");
  };

  const openPinModal = (type: string, poId: string, status?: string) => {
    setPinAction({ type, poId, status });
    setPinValue("");
    setPinError("");
    setPinModalOpen(true);
  };

  const handlePinSubmit = () => {
    if (!pinAction || !pinValue) return;
    const fd = new FormData();
    if (pinAction.type === 'approveSend') {
      fd.append('actionType', 'approveSendPO');
      fd.append('poId', pinAction.poId);
      fd.append('pin', pinValue);
    } else if (pinAction.type === 'updateStatus') {
      fd.append('actionType', 'updateStatus');
      fd.append('poId', pinAction.poId);
      fd.append('status', pinAction.status || '');
      fd.append('pin', pinValue);
    }
    submit(fd, { method: 'post' });
    setPinModalOpen(false);
  };

  const handleTestOdoo = () => {
    const fd = new FormData();
    fd.append('actionType', 'testOdoo');
    fd.append('odooUrl', odooUrl);
    fd.append('odooDatabase', odooDatabase);
    fd.append('odooApiKey', odooApiKey);
    setOdooTestResult('Testing...');
    submit(fd, { method: 'post' });
  };

  const handleSaveOdoo = () => {
    const fd = new FormData();
    fd.append('actionType', 'saveOdooConfig');
    fd.append('odooEnabled', odooEnabled ? 'true' : 'false');
    fd.append('odooUrl', odooUrl);
    fd.append('odooDatabase', odooDatabase);
    fd.append('odooApiKey', odooApiKey);
    submit(fd, { method: 'post' });
    setShowOdoo(false);
  };

  const handleOdooSync = (poId: string, syncAction: string) => {
    const fd = new FormData();
    fd.append('actionType', 'odooSync');
    fd.append('poId', poId);
    fd.append('syncAction', syncAction);
    submit(fd, { method: 'post' });
  };

  const handleCreateSupplier = () => {
    if (!supName) return;
    const fd = new FormData();
    fd.append("actionType", "createSupplier");
    fd.append("name", supName); fd.append("email", supEmail);
    fd.append("contactName", supContact); fd.append("phone", supPhone);
    fd.append("leadTimeDays", supLeadTime);
    submit(fd, { method: "post" });
    setShowSupplier(false); setSupName(""); setSupEmail(""); setSupContact(""); setSupPhone("");
  };

  const handleSaveCompanyInfo = () => {
    const fd = new FormData();
    fd.append("actionType", "updateCompanyInfo");
    fd.append("companyName", companyName); fd.append("companyAddress", companyAddress);
    fd.append("companyPhone", companyPhone); fd.append("companyEmail", companyEmail);
    fd.append("companyLogo", companyLogo);
    submit(fd, { method: "post" });
    setShowCompanyInfo(false);
  };

  const supplierOptions = suppliers.map((s: any) => ({ label: `${s.name}${s.email ? ` (${s.email})` : ''}`, value: s.id }));

  return (
    <Page title="📋 Purchase Orders"
      primaryAction={canCreate ? { content: "Create Purchase Order", onAction: () => setShowCreate(true) } : undefined}
      secondaryActions={canCreate ? [
        { content: "Add Supplier", onAction: () => setShowSupplier(true) },
        { content: "Company Info", onAction: () => setShowCompanyInfo(true) },
        ...(config?.odooEnabled ? [{ content: "🔗 Odoo Integration", onAction: () => setShowOdoo(true) }] : [{ content: "🔗 Connect Odoo", onAction: () => setShowOdoo(true) }])
      ] : []}
    >
      <Layout>
        {/* Summary */}
        <Layout.Section>
          <InlineStack gap="400" wrap>
            <div style={{ flex: 1, minWidth: '150px' }}><Card padding="400"><BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">Total POs</Text>
              <Text as="p" variant="headingXl">{purchaseOrders.length}</Text>
            </BlockStack></Card></div>
            <div style={{ flex: 1, minWidth: '150px' }}><Card padding="400"><BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">Open</Text>
              <Text as="p" variant="headingXl">{purchaseOrders.filter((p: any) => ["draft","sent","partially_received"].includes(p.status)).length}</Text>
            </BlockStack></Card></div>
            <div style={{ flex: 1, minWidth: '150px' }}><Card padding="400"><BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">Suppliers</Text>
              <Text as="p" variant="headingXl">{suppliers.length}</Text>
            </BlockStack></Card></div>
          </InlineStack>
        </Layout.Section>

        {/* PO List */}
        <Layout.Section>
          <Card padding="0">
            {purchaseOrders.length === 0 ? (
              <Box padding="400">
                <Banner tone="info"><p>No purchase orders yet. Click <strong>"Create Purchase Order"</strong> to get started. You'll need to add a supplier first.</p></Banner>
              </Box>
            ) : (
              <IndexTable
                resourceName={{ singular: 'purchase order', plural: 'purchase orders' }}
                itemCount={purchaseOrders.length}
                headings={[
                  { title: 'PO Number' }, { title: 'Supplier' }, { title: 'Status' },
                  { title: 'Items' }, { title: 'Total Cost' }, { title: 'Expected' },
                  { title: 'Created' },
                  ...(config?.odooEnabled ? [{ title: 'Odoo' }] : []),
                  { title: 'Actions' }
                ]}
                selectable={false}
              >
                {purchaseOrders.map((po: any, index: number) => (
                  <IndexTable.Row id={po.id} key={po.id} position={index}>
                    <IndexTable.Cell><Text as="span" variant="bodyMd" fontWeight="bold">{po.poNumber}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodyMd">{po.supplier?.name || '—'}</Text></IndexTable.Cell>
                    <IndexTable.Cell><StatusBadge status={po.status} /></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodyMd">{po.receivedUnits}/{po.totalUnits}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodyMd">${po.totalCost.toFixed(2)}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodySm">{po.expectedDate ? new Date(po.expectedDate).toLocaleDateString() : '—'}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodySm">{new Date(po.createdAt).toLocaleDateString()}</Text></IndexTable.Cell>
                    {config?.odooEnabled && (
                      <IndexTable.Cell>
                        <InlineStack gap="100">
                          {po.odooSyncStatus === 'synced' && <Badge tone="success">Synced #{po.odooPOId}</Badge>}
                          {po.odooSyncStatus === 'pending' && <Badge tone="attention">Syncing...</Badge>}
                          {po.odooSyncStatus === 'error' && <Badge tone="critical" title={po.odooSyncError}>Error</Badge>}
                          {!po.odooSyncStatus && po.status === 'sent' && (
                            <Button size="slim" onClick={() => handleOdooSync(po.id, 'push')}>Push</Button>
                          )}
                          {po.odooSyncStatus === 'synced' && (
                            <Button size="slim" onClick={() => handleOdooSync(po.id, 'pull')}>Pull</Button>
                          )}
                        </InlineStack>
                      </IndexTable.Cell>
                    )}
                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        {po.status === "draft" && po.supplier?.email && (
                          <Button size="slim" onClick={() => openPinModal('approveSend', po.id)}>Approve & Send</Button>
                        )}
                        {po.status === "draft" && (
                          <Button size="slim" tone="critical" onClick={() => { const fd = new FormData(); fd.append("actionType", "deletePO"); fd.append("poId", po.id); submit(fd, { method: "post" }); }}>Delete</Button>
                        )}
                        {po.status === "received" && (
                          <Button size="slim" onClick={() => openPinModal('updateStatus', po.id, 'closed')}>Close (PIN)</Button>
                        )}
                        {po.status === "sent" && (
                          <Button size="slim" tone="critical" onClick={() => openPinModal('updateStatus', po.id, 'cancelled')}>Cancel (PIN)</Button>
                        )}
                        {po.approvedBy && (
                          <Badge tone="success">✓ {po.approvedBy}</Badge>
                        )}
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      {/* Create PO Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={`Create Purchase Order: ${nextPoNumber}`} primaryAction={{ content: "Create PO", onAction: handleCreatePO, disabled: !poSupplierId || lineItems.length === 0 }} secondaryActions={[{ content: "Cancel", onAction: () => setShowCreate(false) }]}>
        <Modal.Section>
          <BlockStack gap="400">
            <Select label="Supplier" options={[{ label: "Select supplier...", value: "" }, ...supplierOptions]} value={poSupplierId} onChange={setPoSupplierId} />
            <InlineStack gap="400">
              <div style={{ flex: 1 }}><TextField label="Expected Delivery" type="date" value={poExpectedDate} onChange={setPoExpectedDate} autoComplete="off" /></div>
              <div style={{ flex: 1 }}><TextField label="Notes" value={poNotes} onChange={setPoNotes} autoComplete="off" /></div>
            </InlineStack>

            <Text as="h3" variant="headingMd">Line Items</Text>
            {lineItems.map((li, i) => (
              <InlineStack key={i} align="space-between" blockAlign="center">
                <Text as="span" variant="bodyMd">{li.productName} — {li.qty} × ${li.cost.toFixed(2)}</Text>
                <Button size="slim" tone="critical" onClick={() => setLineItems(lineItems.filter((_, j) => j !== i))}>Remove</Button>
              </InlineStack>
            ))}

            <Card padding="300">
              <BlockStack gap="200">
                <Combobox activator={<Combobox.TextField label="Product" value={liProductInput} onChange={updateLiProduct} placeholder="Search..." autoComplete="off" />}>
                  {liProductOptions.length > 0 ? (
                    <Listbox onSelect={(sel) => { setLiProductId(sel); const f = variants.find((v: any) => v.value === sel); setLiProductName(f?.label || sel); setLiSku(f?.sku || ''); setLiProductInput(f?.label || sel); }}>
                      {liProductOptions.map((o: any) => <Listbox.Option key={o.value} value={o.value}>{o.label}</Listbox.Option>)}
                    </Listbox>
                  ) : null}
                </Combobox>
                <InlineStack gap="200">
                  <div style={{ width: '100px' }}><TextField label="Qty" type="number" value={liQty} onChange={setLiQty} autoComplete="off" /></div>
                  <div style={{ width: '120px' }}><TextField label="Unit Cost $" type="number" value={liCost} onChange={setLiCost} autoComplete="off" /></div>
                  <div style={{ paddingTop: '24px' }}><Button onClick={addLineItem} disabled={!liProductId}>Add</Button></div>
                </InlineStack>
              </BlockStack>
            </Card>

            {lineItems.length > 0 && (
              <Text as="p" variant="bodyMd" fontWeight="bold">
                Total: {lineItems.reduce((s, l) => s + l.qty, 0)} units — ${lineItems.reduce((s, l) => s + l.qty * l.cost, 0).toFixed(2)}
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Create Supplier Modal */}
      <Modal open={showSupplier} onClose={() => setShowSupplier(false)} title="Add Supplier" primaryAction={{ content: "Add Supplier", onAction: handleCreateSupplier, disabled: !supName }} secondaryActions={[{ content: "Cancel", onAction: () => setShowSupplier(false) }]}>
        <Modal.Section>
          <FormLayout>
            <TextField label="Supplier Name" value={supName} onChange={setSupName} autoComplete="off" requiredIndicator />
            <TextField label="Email" type="email" value={supEmail} onChange={setSupEmail} autoComplete="off" helpText="POs will be emailed here" />
            <TextField label="Contact Name" value={supContact} onChange={setSupContact} autoComplete="off" />
            <TextField label="Phone" value={supPhone} onChange={setSupPhone} autoComplete="off" />
            <TextField label="Lead Time" type="number" value={supLeadTime} onChange={setSupLeadTime} suffix="days" autoComplete="off" />
          </FormLayout>
        </Modal.Section>
      </Modal>

      {/* Company Info Modal */}
      <Modal open={showCompanyInfo} onClose={() => setShowCompanyInfo(false)} title="Company Information (for PO Documents)" primaryAction={{ content: "Save", onAction: handleSaveCompanyInfo }} secondaryActions={[{ content: "Cancel", onAction: () => setShowCompanyInfo(false) }]}>
        <Modal.Section>
          <FormLayout>
            <TextField label="Company Logo URL" value={companyLogo} onChange={setCompanyLogo} autoComplete="off" helpText="Paste a URL to your company logo image. This will appear on purchase orders." placeholder="https://..." />
            {companyLogo && <div style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '8px', textAlign: 'center' }}><img src={companyLogo} alt="Logo preview" style={{ maxHeight: '80px' }} /></div>}
            <TextField label="Company Name" value={companyName} onChange={setCompanyName} autoComplete="off" />
            <TextField label="Company Address" value={companyAddress} onChange={setCompanyAddress} autoComplete="off" multiline={2} />
            <TextField label="Phone" value={companyPhone} onChange={setCompanyPhone} autoComplete="off" />
            <TextField label="Email" type="email" value={companyEmail} onChange={setCompanyEmail} autoComplete="off" />
          </FormLayout>
        </Modal.Section>
      </Modal>

      {/* Manager PIN Verification Modal */}
      <Modal
        open={pinModalOpen}
        onClose={() => setPinModalOpen(false)}
        title="🔐 Manager Authorization Required"
        primaryAction={{ content: "Authorize", onAction: handlePinSubmit, disabled: pinValue.length < 4 }}
        secondaryActions={[{ content: "Cancel", onAction: () => setPinModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Banner tone="warning">
              <p>This action requires manager or owner PIN verification.</p>
            </Banner>
            <TextField
              label="Manager PIN"
              type="password"
              value={pinValue}
              onChange={setPinValue}
              autoComplete="off"
              maxLength={6}
              placeholder="Enter PIN..."
              focused={pinModalOpen}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Odoo Integration Modal */}
      <Modal
        open={showOdoo}
        onClose={() => setShowOdoo(false)}
        title="🔗 Odoo ERP Integration"
        primaryAction={{ content: "Save Configuration", onAction: handleSaveOdoo }}
        secondaryActions={[{ content: "Cancel", onAction: () => setShowOdoo(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <p>Connect to Odoo to automatically sync purchase orders. Approved POs will be pushed to Odoo when sent to suppliers.</p>
            </Banner>
            <Checkbox label="Enable Odoo Integration" checked={odooEnabled} onChange={setOdooEnabled} />
            {odooEnabled && (
              <>
                <TextField label="Odoo URL" value={odooUrl} onChange={setOdooUrl} autoComplete="off" placeholder="https://mycompany.odoo.com" helpText="Your Odoo instance URL (no trailing slash)" />
                <TextField label="Database Name" value={odooDatabase} onChange={setOdooDatabase} autoComplete="off" placeholder="mycompany_prod" />
                <TextField label="API Key" value={odooApiKey} onChange={setOdooApiKey} autoComplete="off" type="password" helpText="Generate in Odoo: Settings → Users → API Keys" />
                <InlineStack gap="200">
                  <Button onClick={handleTestOdoo} disabled={!odooUrl || !odooDatabase || !odooApiKey}>Test Connection</Button>
                  {odooTestResult && <Text as="span" variant="bodySm">{odooTestResult}</Text>}
                </InlineStack>
              </>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
