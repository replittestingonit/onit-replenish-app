import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, TextField, Select, Button, Banner, FormLayout, Checkbox, DropZone, Thumbnail, InlineStack, Combobox, Listbox, Icon, Modal } from "@shopify/polaris";
import { NoteIcon, SearchIcon } from "@shopify/polaris-icons";
import { useState, useMemo, useCallback, useEffect } from "react";
import prisma from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY || "re_12345");

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const { admin } = await unauthenticated.admin(shop);

  const config = await prisma.appConfiguration.findUnique({ where: { shop } });

  // Auto-detect current user
  let currentUser = 'Shopify User';
  try {
    const onlineUser = (session as any).onlineAccessInfo?.associated_user;
    if (onlineUser) {
      currentUser = `${onlineUser.first_name} ${onlineUser.last_name}`.trim();
    }
  } catch (e) {
    console.error('Failed to detect current user:', e);
  }

  // Fetch Locations
  const locRes = await admin.graphql(`
    query { locations(first: 10, query: "active:true") { edges { node { id name } } } }
  `);
  const locData = await locRes.json();
  let locations = locData.data?.locations?.edges.map((e: any) => e.node) || [];

  // Apply Staff Location Constraints
  const constraints = JSON.parse(config?.staffLocationConstraints || "{}");
  if (currentUser && constraints[currentUser] && Array.isArray(constraints[currentUser])) {
    locations = locations.filter((loc: any) => constraints[currentUser].includes(loc.id));
  }

  // Fetch Products/Variants
  const prodRes = await admin.graphql(`
    query {
      products(first: 50, query: "status:active") {
        edges {
          node {
            title
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  sku
                  inventoryItem { id }
                }
              }
            }
          }
        }
      }
    }
  `);
  const prodData = await prodRes.json();
  const variants: any[] = [];
  const products = prodData.data?.products?.edges || [];
  for (const p of products) {
    for (const v of (p.node.variants.edges || [])) {
      if (v.node.inventoryItem?.id) {
        const skuStr = v.node.sku ? ` (SKU: ${v.node.sku})` : '';
        variants.push({
          label: `${p.node.title}${v.node.title !== 'Default Title' ? ` - ${v.node.title}` : ''}${skuStr}`,
          value: v.node.inventoryItem.id,
          sku: v.node.sku || ''
        });
      }
    }
  }

  const pastEvents = await prisma.inventoryEvent.findMany({
    where: { shop, referenceNumber: { not: null } },
    select: { referenceNumber: true },
    distinct: ['referenceNumber']
  });

  const supplierNames = new Set<string>();
  pastEvents.forEach(event => {
    if (event.referenceNumber) {
      const match = event.referenceNumber.match(/From: (.*?)( \||$)/);
      if (match && match[1]) supplierNames.add(match[1].trim());
    }
  });

  // Fetch open Purchase Orders for the PO selector (PRICE-BLIND: strip cost data)
  const rawPOs = await prisma.purchaseOrder.findMany({
    where: { shop, status: { in: ['sent', 'partially_received'] } },
    include: { supplier: { select: { id: true, name: true } }, lineItems: true },
    orderBy: { createdAt: 'desc' }
  });
  // Strip all cost/price fields — receiving staff sees quantities only
  const openPOs = rawPOs.map(po => ({
    id: po.id, poNumber: po.poNumber, status: po.status,
    totalUnits: po.totalUnits, receivedUnits: po.receivedUnits,
    supplier: po.supplier,
    lineItems: po.lineItems.map(li => ({
      id: li.id, inventoryItemId: li.inventoryItemId,
      productName: li.productName, sku: li.sku,
      orderedQty: li.orderedQty, receivedQty: li.receivedQty
      // unitCost deliberately excluded
    }))
  }));

  return json({
    locations,
    variants,
    supplierNames: Array.from(supplierNames).sort(),
    openPOs,
    config: {
      requireInboundReference: config?.requireInboundReference || false,
      evidenceStorage: config?.evidenceStorage || "email",
      googleDriveEnabled: config?.googleDriveEnabled || false,
      serialNumberRequiredItems: JSON.parse(config?.serialNumberRequiredItems || "[]"),
      requireSkuScanAll: config?.requireSkuScanAll || false,
      skuRequiredItems: JSON.parse(config?.skuRequiredItems || "[]"),
    },
    currentUser
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const { admin } = await unauthenticated.admin(shop);

  const formData = await request.formData();
  const inventoryItemId = formData.get("inventoryItemId") as string;
  const locationId = formData.get("locationId") as string;
  const deltaStr = formData.get("delta") as string;
  const staffName = formData.get("staffName") as string;
  const supplierName = formData.get("supplierName") as string || "";
  const poNumber = formData.get("poNumber") as string || "";
  const invoiceNumber = formData.get("invoiceNumber") as string || "";
  const packingSlipNumber = formData.get("packingSlipNumber") as string || "";
  const isFullyMetStr = formData.get("isFullyMet") as string;
  const resourceUrlsStr = formData.get("resourceUrls") as string;
  const exceptionNote = formData.get("exceptionNote") as string;
  const serialNumbersText = formData.get("serialNumbersText") as string;

  const reason = "New Inventory Received";

  const refParts: string[] = [];
  if (poNumber) refParts.push(`PO: ${poNumber}`);
  if (invoiceNumber) refParts.push(`INV: ${invoiceNumber}`);
  if (packingSlipNumber) refParts.push(`PS: ${packingSlipNumber}`);
  if (supplierName) refParts.push(`From: ${supplierName}`);
  if (serialNumbersText) refParts.push(`Serials: ${serialNumbersText}`);
  const referenceNumber = refParts.join(' | ') || '';

  if (!inventoryItemId || !locationId || !deltaStr || !staffName) {
    return json({ error: "Missing required fields" }, { status: 400 });
  }

  const delta = parseInt(deltaStr, 10);
  if (isNaN(delta) || delta <= 0) {
    return json({ error: "Quantity must be a positive number for receiving." }, { status: 400 });
  }

  const config = await prisma.appConfiguration.findUnique({ where: { shop } });

  const managerOverridePin = formData.get("managerOverridePin") as string;
  const activeRules = await prisma.securityRule.findMany({ where: { shop, isActive: true } });

  let isOverrideValid = false;
  let overriderName = "MANAGER OVERRIDE";

  if (managerOverridePin) {
    if (config?.masterOverridePin && managerOverridePin === config.masterOverridePin) {
      isOverrideValid = true;
      overriderName = "MASTER OVERRIDE";
    } else {
      const delegated = JSON.parse(config?.delegatedManagerPins || "{}");
      for (const [name, pin] of Object.entries(delegated)) {
        if (pin === managerOverridePin) {
          isOverrideValid = true;
          overriderName = `MANAGER OVERRIDE (${name})`;
          break;
        }
      }
    }
  }

  // Evaluate Supplier Over-Receiving Rule
  const overReceivingRule = activeRules.find(r => r.triggerType === "supplier_over_receiving");
  if (overReceivingRule && overReceivingRule.haltFulfillment && config?.planType === 'premium') {
    const threshold = overReceivingRule.quantityThreshold ? parseInt(overReceivingRule.quantityThreshold, 10) : 100;
    
    if (delta > threshold && !isOverrideValid) {
      await prisma.triggeredAlert.create({
        data: {
          shop,
          ruleId: overReceivingRule.id,
          person: staffName,
          productName: `Item ID: ${inventoryItemId}`,
          details: `Staff attempted to receive ${delta} units, exceeding the configured inbound limit of ${threshold}.`,
          status: "active"
        }
      });
      return json({ error: "MANAGER_OVERRIDE_REQUIRED", message: `Supplier Overage Detected: Attempting to receive ${delta} units exceeds the limit of ${threshold}. Please call a manager to override.` }, { status: 403 });
    } else if (isOverrideValid && delta > threshold) {
      await prisma.triggeredAlert.create({
        data: {
          shop,
          ruleId: overReceivingRule.id,
          person: overriderName,
          productName: `Item ID: ${inventoryItemId}`,
          details: `Manager manually overrode an inbound overage attempt of ${delta} units by ${staffName}.`,
          status: "silenced"
        }
      });
    }
  }

  // Finalize Staged Uploads
  let shopifyFileIds: string[] = [];
  if (resourceUrlsStr) {
    try {
      const resourceUrls = JSON.parse(resourceUrlsStr);
      if (resourceUrls.length > 0) {
        const fileInputs = resourceUrls.map((url: string) => ({
          alt: "Inbound Evidence",
          contentType: "FILE",
          originalSource: url
        }));
        const fileCreateRes = await admin.graphql(`
          mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
              files { id fileStatus }
              userErrors { field message }
            }
          }
        `, { variables: { files: fileInputs } });
        const fileData = await fileCreateRes.json();
        shopifyFileIds = (fileData.data?.fileCreate?.files || []).map((f: any) => f.id);
      }
    } catch (e) {
      console.error("Failed to upload files", e);
    }
  }

  let finalProofReference = null;
  if (shopifyFileIds.length > 0) {
    finalProofReference = JSON.stringify(shopifyFileIds);
  } else if (exceptionNote) {
    finalProofReference = `Exception: ${exceptionNote}`;
  }

  // Adjust inventory
  let adjustData: any = null;
  try {
    const adjustRes = await admin.graphql(`
      mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          userErrors { field message }
          inventoryAdjustmentGroup { id }
        }
      }
    `, {
      variables: {
        input: {
          reason: "correction",
          name: "available",
          changes: [{ delta, inventoryItemId, locationId }]
        }
      }
    });
    adjustData = await adjustRes.json();
    const errors = adjustData.data?.inventoryAdjustQuantities?.userErrors;
    if (errors && errors.length > 0) {
      return json({ error: errors[0].message }, { status: 400 });
    }
  } catch (error: any) {
    console.error("GraphQL Adjust Error:", error);
    return json({ error: "Failed to adjust inventory." }, { status: 500 });
  }

  const adjustmentGroupId = adjustData.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup?.id || null;

  // Stitch staff name to webhook event
  await new Promise(resolve => setTimeout(resolve, 2000));
  const recentEvent = await prisma.inventoryEvent.findFirst({
    where: {
      shop, inventoryItemId,
      time: { gte: new Date(Date.now() - 30000) },
      reason: { startsWith: 'Location: ' }
    },
    orderBy: { time: 'desc' }
  });

  const finalReason = `Inbound Receiving - ${staffName} (${reason})`;
  if (recentEvent) {
    await prisma.inventoryEvent.update({
      where: { id: recentEvent.id },
      data: {
        reason: finalReason,
        referenceNumber: referenceNumber || null,
        isFullyMet: isFullyMetStr === 'true',
        proofImage: finalProofReference,
        shopifyAdjustmentGroupId: adjustmentGroupId
      }
    });
  } else {
    await prisma.inventoryEvent.create({
      data: {
        shop, inventoryItemId,
        time: new Date(),
        available: 0,
        reason: finalReason,
        referenceNumber: referenceNumber || null,
        isFullyMet: isFullyMetStr === 'true',
        proofImage: finalProofReference,
        shopifyAdjustmentGroupId: adjustmentGroupId
      }
    });
  }

  // Supplier mismatch alert
  if (referenceNumber && isFullyMetStr === 'false') {
    let mismatchRule = await prisma.securityRule.findFirst({
      where: { shop, triggerType: 'supplier_mismatch' }
    });
    if (!mismatchRule) {
      mismatchRule = await prisma.securityRule.create({
        data: {
          shop, name: 'Supplier Mismatch',
          description: 'Fires when receiving staff logs a physical discrepancy against a packing slip.',
          triggerType: 'supplier_mismatch', isActive: true
        }
      });
    }

    await prisma.triggeredAlert.create({
      data: {
        shop, ruleId: mismatchRule.id, person: staffName,
        productName: `Item ID: ${inventoryItemId}`,
        details: `Short-shipment reported against inbound reference ${referenceNumber}.`,
        status: 'active', transactionId: finalProofReference
      }
    });

    if (config?.emailAlertsEnabled && config?.alertEmailAddress) {
      const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
      try {
        await resend.emails.send({
          from: "ONIT Security <alerts@onitnetworking.com>",
          to: emailList,
          subject: "🚨 SECURITY ALERT: Supplier Mismatch",
          html: `
            <h2>Supplier Mismatch Detected</h2>
            <p><strong>Staff:</strong> ${staffName}</p>
            <p><strong>Supplier:</strong> ${supplierName}</p>
            <p><strong>Reference:</strong> ${referenceNumber}</p>
            <p><strong>Quantity Received:</strong> +${delta} units</p>
            <p><strong>Fully Met:</strong> No — short shipment reported</p>
          `
        });
      } catch (err) {
        console.error("Failed to send mismatch alert", err);
      }
    }
  }

  const skuBypassReason = formData.get("skuBypassReason") as string;
  const skuScanned = formData.get("skuScanned") === "true";
  const requiresSkuScan = config?.requireSkuScanAll || JSON.parse(config?.skuRequiredItems || "[]").includes(inventoryItemId);

  if (requiresSkuScan && !skuScanned && skuBypassReason) {
    let bypassRule = await prisma.securityRule.findFirst({
      where: { shop, triggerType: 'sku_scan_bypassed' }
    });
    if (!bypassRule) {
      bypassRule = await prisma.securityRule.create({
        data: {
          shop, name: 'Mandatory Barcode Scan Bypassed',
          description: 'Fires when a worker bypasses a mandatory barcode scan requirement during receiving.',
          triggerType: 'sku_scan_bypassed', isActive: true
        }
      });
    }

    await prisma.triggeredAlert.create({
      data: {
        shop, ruleId: bypassRule.id, person: staffName,
        productName: `Item ID: ${inventoryItemId}`,
        details: `Worker bypassed mandatory SKU scan. Reason: ${skuBypassReason}`,
        status: 'active', transactionId: finalProofReference
      }
    });

    if (config?.emailAlertsEnabled && config?.alertEmailAddress) {
      const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
      try {
        await resend.emails.send({
          from: "ONIT Security <alerts@onitnetworking.com>",
          to: emailList,
          subject: "🚨 SECURITY ALERT: Mandatory Scan Bypassed",
          html: `
            <h2>Barcode Scan Bypassed</h2>
            <p><strong>Staff:</strong> ${staffName}</p>
            <p><strong>Product ID:</strong> ${inventoryItemId}</p>
            <p><strong>Reason Given:</strong> ${skuBypassReason}</p>
            <p><strong>Quantity Received:</strong> +${delta} units</p>
          `
        });
      } catch (err) {
        console.error("Failed to send bypass alert", err);
      }
    }
  }

  // Update linked PO line item received quantities
  const linkedPoId = formData.get("linkedPoId") as string;
  const linkedLineItemId = formData.get("linkedLineItemId") as string;
  if (linkedPoId && linkedLineItemId) {
    try {
      const delta = parseInt(deltaStr, 10);
      await prisma.purchaseOrderLineItem.update({
        where: { id: linkedLineItemId },
        data: {
          receivedQty: { increment: delta },
          receivedBy: staffName,
          receivedAt: new Date()
        }
      });
      // Recalculate PO totals
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: linkedPoId },
        include: { lineItems: true }
      });
      if (po) {
        const totalReceived = po.lineItems.reduce((s, li) => s + li.receivedQty, 0);
        const allReceived = po.lineItems.every(li => li.receivedQty >= li.orderedQty);
        await prisma.purchaseOrder.update({
          where: { id: linkedPoId },
          data: {
            receivedUnits: totalReceived,
            status: allReceived ? 'received' : 'partially_received'
          }
        });
      }
    } catch (err) {
      console.error('Failed to update PO line item:', err);
    }
  }

  return json({ success: true });
};

export default function InboundReceiving() {
  const { locations, variants, config, currentUser, supplierNames, openPOs } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const actionData = useActionData<typeof action>();

  const [staffName, setStaffName] = useState(currentUser || "");
  const [inventoryItemId, setInventoryItemId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [delta, setDelta] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [linkedPoId, setLinkedPoId] = useState("");
  const [linkedLineItemId, setLinkedLineItemId] = useState("");
  const [poExpectedQty, setPoExpectedQty] = useState<number | null>(null);

  const handlePoSelect = useCallback((poId: string) => {
    setLinkedPoId(poId);
    if (!poId) { setLinkedLineItemId(''); setPoExpectedQty(null); return; }
    const po = openPOs.find((p: any) => p.id === poId);
    if (po) {
      setSupplierName(po.supplier?.name || '');
      setPoNumber(po.poNumber);
    }
  }, [openPOs]);

  const handlePoLineItemSelect = useCallback((lineItemId: string) => {
    setLinkedLineItemId(lineItemId);
    if (!lineItemId || !linkedPoId) return;
    const po = openPOs.find((p: any) => p.id === linkedPoId);
    if (!po) return;
    const li = po.lineItems.find((l: any) => l.id === lineItemId);
    if (li) {
      const remaining = li.orderedQty - li.receivedQty;
      setDelta(remaining.toString());
      setPoExpectedQty(remaining);
      // Auto-select the product
      const gid = `gid://shopify/InventoryItem/${li.inventoryItemId}`;
      const found = variants.find((v: any) => v.value === gid || v.value === li.inventoryItemId);
      if (found) {
        setInventoryItemId(found.value);
        setProductInputValue(found.label);
      } else {
        setInventoryItemId(gid);
      }
    }
  }, [linkedPoId, openPOs, variants]);
  
  const filteredSuppliers = useMemo(() => {
    if (!supplierNames) return [];
    if (!supplierName) return supplierNames;
    const q = supplierName.toLowerCase();
    return supplierNames.filter((s: string) => s.toLowerCase().includes(q));
  }, [supplierName, supplierNames]);

  const [poNumber, setPoNumber] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [packingSlipNumber, setPackingSlipNumber] = useState("");
  const [isFullyMet, setIsFullyMet] = useState(false);
  const [exceptionNote, setExceptionNote] = useState("");
  const [serialNumbersText, setSerialNumbersText] = useState("");
  const [proofVerified, setProofVerified] = useState(false);
  const [proofFiles, setProofFiles] = useState<{file: File, url: string, isUploading: boolean, resourceUrl?: string}[]>([]);
  const [skuScanned, setSkuScanned] = useState(false);
  const [skuBypassReason, setSkuBypassReason] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);

  const [showManagerModal, setShowManagerModal] = useState(false);
  const [managerOverridePin, setManagerOverridePin] = useState("");

  useEffect(() => {
    if (actionData && 'error' in actionData) {
      if (actionData.error === "MANAGER_OVERRIDE_REQUIRED") {
        setShowManagerModal(true);
      }
    }
  }, [actionData]);
  // Product search
  const [productInputValue, setProductInputValue] = useState("");
  const filteredVariants = useMemo(() => {
    if (!productInputValue) return variants;
    const q = productInputValue.toLowerCase();
    return variants.filter((v: any) => v.label.toLowerCase().includes(q) || v.sku.toLowerCase().includes(q));
  }, [productInputValue, variants]);

  useEffect(() => {
    const savedLocation = window.localStorage.getItem('preferredReceivingLocationId');
    if (savedLocation && !locationId) {
      // Validate the saved location actually exists in the options
      const valid = locations.find((l: any) => l.id === savedLocation);
      if (valid) setLocationId(savedLocation);
    }
  }, [locations]);

  const handleLocationChange = useCallback((val: string) => {
    setLocationId(val);
    window.localStorage.setItem('preferredReceivingLocationId', val);
  }, []);

  // Barcode scanner
  const handleBarcodeScan = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("receive-scan-region");
      const decodedText = await scanner.scanFile(file, true);
      const found = variants.find((v: any) => v.sku === decodedText || v.label.includes(decodedText) || v.value.includes(decodedText));
      if (found) {
        setInventoryItemId(found.value);
        setProductInputValue(found.label);
        setSkuScanned(true);
        if (typeof shopify !== 'undefined' && (shopify as any)?.toast) {
          (shopify as any).toast.show("Product scanned successfully!");
        }
      } else {
        if (typeof shopify !== 'undefined' && (shopify as any)?.toast) {
          (shopify as any).toast.show(`Barcode ${decodedText} not found`, { isError: true });
        }
      }
      await scanner.clear();
    } catch (err) {
      if (typeof shopify !== 'undefined' && (shopify as any)?.toast) {
        (shopify as any).toast.show("Could not read barcode. Try a clearer photo.", { isError: true });
      }
    }
    e.target.value = '';
  }, [variants]);

  const locOptions = useMemo(() => [
    { label: "Select a location...", value: "" },
    ...locations.map((l: any) => ({ label: l.name, value: l.id }))
  ], [locations]);

  const handleDropZoneDrop = useCallback(
    async (_dropFiles: File[], acceptedFiles: File[], _rejectedFiles: File[]) => {
      setFileError(null);
      if (proofFiles.length + acceptedFiles.length > 10) {
        setFileError("You can only upload up to 10 files.");
        return;
      }
      const newFiles = acceptedFiles.filter(f => {
        if (f.type.startsWith('video/') && f.size > 1000 * 1024 * 1024) {
          setFileError("Video must be smaller than 1 GB.");
          return false;
        } else if (!f.type.startsWith('video/') && f.size > 20 * 1024 * 1024) {
          setFileError("Images/PDFs must be smaller than 20 MB.");
          return false;
        }
        return true;
      }).map(f => ({
        file: f, url: URL.createObjectURL(f), isUploading: true
      }));
      setProofFiles(prev => [...prev, ...newFiles]);
      // Upload via staged upload API
      for (const nf of newFiles) {
        try {
          const resp = await fetch('/api/staged-upload', {
            method: 'POST',
            body: JSON.stringify({ filename: nf.file.name, mimeType: nf.file.type, fileSize: nf.file.size }),
            headers: { 'Content-Type': 'application/json' }
          });
          const { url, resourceUrl, parameters } = await resp.json();
          const formData = new FormData();
          for (const p of parameters) formData.append(p.name, p.value);
          formData.append('file', nf.file);
          await fetch(url, { method: 'POST', body: formData });
          setProofFiles(prev => prev.map(pf =>
            pf.file === nf.file ? { ...pf, isUploading: false, resourceUrl } : pf
          ));
        } catch (err) {
          console.error("Upload failed:", err);
          setProofFiles(prev => prev.map(pf =>
            pf.file === nf.file ? { ...pf, isUploading: false } : pf
          ));
        }
      }
    }, [proofFiles]
  );

  const hasAnyReference = !!(poNumber || invoiceNumber || packingSlipNumber);
  const isSubmitting = nav.state === "submitting";

  const requiresSerial = config.serialNumberRequiredItems?.includes(inventoryItemId);
  const parsedDelta = parseInt(delta, 10);
  
  let isValid = !!(staffName && inventoryItemId && locationId && delta && parsedDelta > 0);
  
  const requiresSkuScan = inventoryItemId && (config.requireSkuScanAll || config.skuRequiredItems?.includes(inventoryItemId));
  if (requiresSkuScan && !skuScanned && skuBypassReason.length < 5) {
    isValid = false;
  }

  if (requiresSerial) {
    const serials = serialNumbersText.split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 0);
    if (serials.length !== parsedDelta) isValid = false;
  }

  if (config.requireInboundReference) {
    if (!hasAnyReference) isValid = false;
    if (!supplierName) isValid = false;
    if (proofFiles.length > 0 && !proofVerified) isValid = false;
    if (proofFiles.length === 0 && exceptionNote.length < 5) isValid = false;
  }

  const handleSubmit = () => {
    const resourceUrls = proofFiles.filter(pf => pf.resourceUrl).map(pf => pf.resourceUrl);
    const serials = serialNumbersText.split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 0).join(', ');
    
    submit({
      inventoryItemId, locationId, delta,
      staffName, supplierName, poNumber, invoiceNumber, packingSlipNumber,
      isFullyMet: isFullyMet ? "true" : "false",
      resourceUrls: JSON.stringify(resourceUrls),
      exceptionNote,
      serialNumbersText: serials,
      skuScanned: skuScanned ? "true" : "false",
      skuBypassReason,
      managerOverridePin,
      linkedPoId,
      linkedLineItemId
    }, { method: "post" });
  };

  // Reset on success
  if (actionData && 'success' in actionData && actionData.success) {
    return (
      <Page title="Receiving" subtitle="Receive inventory from suppliers with full chain-of-custody documentation.">
        <Layout>
          <Layout.Section>
            <Banner title="Inventory Received Successfully!" tone="success">
              <p>The stock has been added and all documentation has been logged.</p>
            </Banner>
            <div style={{ marginTop: '16px' }}>
              <Button variant="primary" onClick={() => window.location.reload()}>Receive More</Button>
            </div>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page title="Receiving" subtitle="Receive inventory from suppliers with full chain-of-custody documentation.">
      <Layout>
        <Layout.Section>
          {actionData && 'error' in actionData && (
            <Banner tone="critical" title="Error"><p>{actionData.error as string}</p></Banner>
          )}

          <Card>
            <FormLayout>
              {/* Purchase Order Quick-Link */}
              {openPOs.length > 0 && (
                <>
                  <Select
                    label="📋 Receive Against Purchase Order (optional)"
                    options={[
                      { label: 'Manual Receiving (no PO)', value: '' },
                      ...openPOs.map((po: any) => ({
                        label: `${po.poNumber} — ${po.supplier?.name || 'Unknown'} (${po.receivedUnits}/${po.totalUnits} received)`,
                        value: po.id
                      }))
                    ]}
                    value={linkedPoId}
                    onChange={handlePoSelect}
                    helpText={linkedPoId ? 'Select a line item below to auto-fill product and quantity' : undefined}
                  />
                  {linkedPoId && (() => {
                    const po = openPOs.find((p: any) => p.id === linkedPoId);
                    if (!po) return null;
                    const pendingItems = po.lineItems.filter((li: any) => li.receivedQty < li.orderedQty);
                    if (pendingItems.length === 0) return <Banner tone="success"><p>All items on this PO have been received!</p></Banner>;
                    return (
                      <Select
                        label="Line Item"
                        options={[
                          { label: 'Select item to receive...', value: '' },
                          ...pendingItems.map((li: any) => ({
                            label: `${li.productName}${li.sku ? ` (${li.sku})` : ''} — ${li.receivedQty}/${li.orderedQty} received`,
                            value: li.id
                          }))
                        ]}
                        value={linkedLineItemId}
                        onChange={handlePoLineItemSelect}
                      />
                    );
                  })()}
                  {poExpectedQty !== null && (
                    <Banner tone="info">
                      <p>Expected remaining quantity: <strong>{poExpectedQty} units</strong>. Product and quantity have been auto-filled.</p>
                    </Banner>
                  )}
                </>
              )}
              <TextField
                label="Your Name (Auto-detected)"
                value={staffName}
                onChange={setStaffName}
                autoComplete="off"
                requiredIndicator
              />

              <InlineStack gap="400" blockAlign="end">
                <div style={{ flexGrow: 1 }}>
                  <Combobox
                    activator={
                      <Combobox.TextField
                        prefix={<Icon source={SearchIcon} />}
                        onChange={setProductInputValue}
                        label="Product / SKU"
                        value={productInputValue}
                        placeholder="Search by name or SKU..."
                        autoComplete="off"
                      />
                    }
                  >
                    {filteredVariants.length > 0 ? (
                      <Listbox onSelect={(selected) => {
                        setInventoryItemId(selected);
                        setSkuScanned(false);
                        const found = variants.find((v: any) => v.value === selected);
                        if (found) setProductInputValue(found.label);
                      }}>
                        {filteredVariants.map((v: any) => (
                          <Listbox.Option key={v.value} value={v.value}>{v.label}</Listbox.Option>
                        ))}
                      </Listbox>
                    ) : null}
                  </Combobox>
                </div>
                <label style={{ cursor: 'pointer', display: 'inline-block', padding: '8px 16px', background: '#2c6ecb', color: 'white', borderRadius: '8px', fontSize: '13px', fontWeight: 600 }}>
                  📷 Scan Barcode
                  <input type="file" accept="image/*" capture="environment" onChange={handleBarcodeScan} style={{ display: 'none' }} />
                </label>
              </InlineStack>
              <div id="receive-scan-region" style={{ display: 'none' }}></div>

              <Select
                label="Receiving Location"
                options={locOptions}
                value={locationId}
                onChange={handleLocationChange}
                requiredIndicator
              />

              <TextField
                label="Quantity Received"
                type="number"
                value={delta}
                onChange={setDelta}
                helpText="Enter the number of units being received (positive number only)."
                autoComplete="off"
                requiredIndicator
              />

              {requiresSkuScan && !skuScanned && (
                <Card background="bg-surface-warning">
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingMd">Mandatory Barcode Scan</Text>
                    <Text as="p" variant="bodySm">
                      This item is configured to require a physical barcode scan. Since you selected it manually, you must either click "📷 Scan Barcode" above, or provide a reason for bypassing the scan.
                    </Text>
                    <TextField
                      label="Bypass Reason"
                      value={skuBypassReason}
                      onChange={setSkuBypassReason}
                      helpText="Bypassing this scan will trigger a security alert to the owner."
                      autoComplete="off"
                      requiredIndicator
                    />
                  </BlockStack>
                </Card>
              )}

              {requiresSerial && (
                <Card background="bg-surface-warning">
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingMd">Serial Numbers Required</Text>
                    <Text as="p" variant="bodySm">
                      This item requires exact serial number tracking. Please scan or enter exactly {parsedDelta || 0} serial numbers (one per line or comma-separated).
                    </Text>
                    <TextField
                      label={`Serial Numbers (${serialNumbersText.split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 0).length} / ${parsedDelta || 0})`}
                      value={serialNumbersText}
                      onChange={setSerialNumbersText}
                      multiline={4}
                      autoComplete="off"
                      requiredIndicator
                    />
                  </BlockStack>
                </Card>
              )}

              <Card background="bg-surface-secondary">
                <BlockStack gap="400">
                  <Text as="h3" variant="headingMd">Supplier & Reference Tracking</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Enter at least one reference number below, plus the supplier name.{config.requireInboundReference ? '' : ' (Optional)'}
                  </Text>

                  <Combobox
                    allowFieldSubmitOnEnter
                    activator={
                      <Combobox.TextField
                        label="From (Manufacturer / Supplier)"
                        value={supplierName}
                        onChange={setSupplierName}
                        autoComplete="off"
                        placeholder="e.g. Acme Manufacturing"
                        requiredIndicator={config.requireInboundReference}
                      />
                    }
                  >
                    {filteredSuppliers.length > 0 ? (
                      <Listbox onSelect={(selected) => setSupplierName(selected)}>
                        {filteredSuppliers.map((s: string) => (
                          <Listbox.Option key={s} value={s}>{s}</Listbox.Option>
                        ))}
                      </Listbox>
                    ) : null}
                  </Combobox>

                  <FormLayout.Group>
                    <TextField label="PO Number" value={poNumber} onChange={setPoNumber} autoComplete="off" placeholder="e.g. PO-2026-0458" />
                    <TextField label="Invoice Number" value={invoiceNumber} onChange={setInvoiceNumber} autoComplete="off" placeholder="e.g. INV-12345" />
                    <TextField label="Packing Slip Number" value={packingSlipNumber} onChange={setPackingSlipNumber} autoComplete="off" placeholder="e.g. PS-98765" />
                  </FormLayout.Group>

                  {config.requireInboundReference && !hasAnyReference && (supplierName !== '') && (
                    <Banner tone="warning">
                      <p>Enter at least one reference number (PO, Invoice, or Packing Slip).</p>
                    </Banner>
                  )}

                  <Checkbox
                    label="Quantity received EXACTLY matches the invoice/slip (Fully Met)"
                    checked={isFullyMet}
                    onChange={setIsFullyMet}
                  />

                  <Text as="p" variant="bodyMd">Upload Proof (Images, Packing Slips, Unboxing Videos)</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Videos upload directly to Shopify (Max 1 GB). Images max 20 MB.
                  </Text>

                  {fileError && <Banner tone="critical"><p>{fileError}</p></Banner>}

                  <DropZone
                    allowMultiple={true}
                    onDrop={handleDropZoneDrop}
                    accept="image/jpeg, image/png, image/heic, image/heif, application/pdf, video/mp4, video/quicktime"
                  >
                    <DropZone.FileUpload actionTitle="Add files" actionHint="Accepts .pdf, .jpg, .heic, .mp4, .mov" />
                  </DropZone>

                  {proofFiles.length > 0 && (
                    <BlockStack gap="300">
                      {proofFiles.map((pf, i) => (
                        <InlineStack align="space-between" blockAlign="center" key={i}>
                          <InlineStack gap="200" blockAlign="center">
                            {pf.file.type.startsWith('image/') ? (
                              <img src={pf.url} alt="Preview" style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '4px' }} />
                            ) : (
                              <Thumbnail size="small" alt={pf.file.name} source={NoteIcon} />
                            )}
                            <Text variant="bodyMd" as="span">{pf.file.name}</Text>
                          </InlineStack>
                          <Text variant="bodySm" tone={pf.isUploading ? "subdued" : "success"} as="span">
                            {pf.isUploading ? "Uploading..." : "Ready"}
                          </Text>
                        </InlineStack>
                      ))}
                      <Checkbox
                        label="I confirm these documents are perfectly clear and complete."
                        checked={proofVerified}
                        onChange={setProofVerified}
                      />
                    </BlockStack>
                  )}

                  {proofFiles.length === 0 && (
                    <TextField
                      label="Exception Note (If evidence is missing)"
                      value={exceptionNote}
                      onChange={setExceptionNote}
                      autoComplete="off"
                      helpText="If you cannot upload evidence right now, explain why. This saves the transaction as a Draft."
                    />
                  )}
                </BlockStack>
              </Card>

              <Button
                variant="primary"
                onClick={handleSubmit}
                disabled={!isValid || isSubmitting}
                loading={isSubmitting}
              >
                Receive Inventory
              </Button>
            </FormLayout>
          </Card>
        </Layout.Section>
        {showManagerModal && (
          <Modal
            open={showManagerModal}
            onClose={() => {
              setShowManagerModal(false);
              setManagerOverridePin("");
            }}
            title="Manager Override Required"
            primaryAction={{
              content: 'Override & Submit',
              onAction: () => {
                setShowManagerModal(false);
                handleSubmit();
              },
            }}
            secondaryActions={[
              {
                content: 'Cancel',
                onAction: () => {
                  setShowManagerModal(false);
                  setManagerOverridePin("");
                },
              },
            ]}
          >
            <Modal.Section>
              <BlockStack gap="400">
                <Banner tone="critical">
                  <p><strong>{actionData?.message || "Transaction Blocked by Security Engine"}</strong></p>
                </Banner>
                <Text as="p">
                  This transaction violates an active Enterprise Security Rule. If you have verbal authorization, a manager must enter their PIN to override this block. Otherwise, please set this item aside.
                </Text>
                <TextField
                  label="Manager PIN"
                  type="password"
                  value={managerOverridePin}
                  onChange={setManagerOverridePin}
                  autoComplete="off"
                  placeholder="Enter 4-digit PIN"
                />
              </BlockStack>
            </Modal.Section>
          </Modal>
        )}
      </Layout>
    </Page>
  );
}
