import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useOutletContext } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, SettingToggle, TextField, Button, InlineStack, Tag, Banner, Badge, Box, Divider, Checkbox, Select, Tooltip, Autocomplete, Icon, Combobox, Listbox, FormLayout } from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useState, useEffect, useMemo, useCallback } from "react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getGoogleAuthUrl, disconnectGoogleDrive } from "../google-drive.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let config = await prisma.appConfiguration.findUnique({ where: { shop } });
  if (!config) {
    config = await prisma.appConfiguration.create({ data: { shop } });
  }

  const reasonRules = await prisma.securityRule.findMany({
    where: { shop, triggerType: "flagged_reason" }
  });

  const { admin } = await authenticate.admin(request);
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
    const vEdges = p.node.variants.edges || [];
    for (const v of vEdges) {
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

  // Fetch Locations for Location Freezing
  const locRes = await admin.graphql(`
    query { locations(first: 10, query: "active:true") { edges { node { id name } } } }
  `);
  const locData = await locRes.json();
  const locations = locData.data?.locations?.edges.map((e: any) => e.node) || [];

  // Fetch Staff Members from Shopify
  let staffMembers: { name: string; email: string }[] = [];
  try {
    const staffRes = await admin.graphql(`
      query { staffMembers(first: 50) { edges { node { firstName lastName email isShopOwner } } } }
    `);
    const staffData = await staffRes.json();
    staffMembers = (staffData.data?.staffMembers?.edges || []).map((e: any) => ({
      name: `${e.node.firstName || ''} ${e.node.lastName || ''}`.trim() || e.node.email,
      email: e.node.email
    }));
  } catch (e: any) {
    console.error('Failed to fetch staff members:', e.message);
  }

  // Fallback / Supplement: Fetch all names that have ever triggered an alert or made an adjustment
  try {
    const pastEvents = await prisma.inventoryEvent.findMany({
      where: { shop },
      select: { reason: true },
      distinct: ['reason']
    });

    const activeStaffNames = new Set<string>();

    pastEvents.forEach(event => {
      // InventoryEvent reason format is usually "Adjustment by John Doe - Reason"
      // or "Inbound Receiving - John Doe (Supplier...)"
      if (event.reason) {
        const byMatch = event.reason.match(/Adjustment by (.*?) -/);
        if (byMatch && byMatch[1]) activeStaffNames.add(byMatch[1].trim());

        const inMatch = event.reason.match(/Inbound Receiving - (.*?) \(/);
        if (inMatch && inMatch[1]) activeStaffNames.add(inMatch[1].trim());
      }
    });

    const pastAlerts = await prisma.triggeredAlert.findMany({
      where: { shop },
      select: { person: true },
      distinct: ['person']
    });
    
    pastAlerts.forEach(alert => {
      if (alert.person) activeStaffNames.add(alert.person.trim());
    });

    activeStaffNames.forEach(name => {
      if (!staffMembers.find(s => s.name === name)) {
        staffMembers.push({ name: name, email: '' });
      }
    });
  } catch (e) {
    console.error('Failed to fetch historical staff:', e);
  }

  const lowStockRules = await prisma.securityRule.findMany({
    where: { shop, triggerType: "low_stock" }
  });

  // API Keys
  const apiKeys = await prisma.apiKey.findMany({
    where: { shop },
    orderBy: { createdAt: 'desc' }
  });
  const maskedApiKeys = apiKeys.map(k => ({
    id: k.id, name: k.name, scope: k.scope, isActive: k.isActive,
    lastUsedAt: k.lastUsedAt, createdAt: k.createdAt, createdBy: k.createdBy,
    key: k.key.substring(0, 12) + '...' + k.key.substring(k.key.length - 4)
  }));

  return json({ 
    config: {
      ...config,
      adjustmentReasons: JSON.parse(config.adjustmentReasons || "[]"),
      alertOnReasons: JSON.parse(config.alertOnReasons || "[]"),
      highValueItems: JSON.parse(config.highValueItems || "[]"),
      serialNumberRequiredItems: JSON.parse(config.serialNumberRequiredItems || "[]"),
      skuRequiredItems: JSON.parse(config.skuRequiredItems || "[]"),
      frozenLocations: JSON.parse(config.frozenLocations || "[]"),
      receiveOnlyStaff: JSON.parse(config.receiveOnlyStaff || "[]"),
      staffLocationConstraints: JSON.parse(config.staffLocationConstraints || "{}"),
      masterOverridePin: config.masterOverridePin || "",
      delegatedManagerPins: JSON.parse(config.delegatedManagerPins || "{}"),
      poViewStaff: JSON.parse(config.poViewStaff || "[]"),
      poAuthorizedStaff: JSON.parse(config.poAuthorizedStaff || "[]"),
      poRequireApproval: config.poRequireApproval,
      poAutoCreateOnLowStock: config.poAutoCreateOnLowStock,
      poAlertEmails: config.poAlertEmails || "",
    },
    reasonRules,
    lowStockRules,
    variants,
    locations,
    staffMembers,
    apiKeys: maskedApiKeys,
    googleAuthUrl: getGoogleAuthUrl(shop)
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  
  const actionType = formData.get("actionType");
  const config = await prisma.appConfiguration.findUnique({ where: { shop } });
  if (!config) return json({ error: "Config not found" }, { status: 404 });

  if (actionType === "upgradeToEnterprise") {
    try {
      const { billing } = await authenticate.admin(request);
      return await billing.request({ plan: "Enterprise WMS Suite", isTest: false });
    } catch (err: any) {
      console.warn("Upgrade failed (likely a custom app):", err.message);
      return json({ success: true, message: "Custom app: Enterprise suite activated automatically." });
    }
  }

  if (actionType === "toggleStrict") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: { strictInventory: formData.get("value") === "true" },
    });
  } else if (actionType === "toggleRequireDetailedReason") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: { requireDetailedReason: formData.get("value") === "true" },
    });
  } else if (actionType === "toggleRequireInbound") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: { requireInboundReference: formData.get("value") === "true" },
    });
  } else if (actionType === "toggleRequireSkuScanAll") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: { requireSkuScanAll: formData.get("value") === "true" },
    });
  } else if (actionType === "addSkuRequiredItem") {
    const item = formData.get("item") as string;
    const list = JSON.parse(config.skuRequiredItems || "[]");
    if (!list.includes(item)) {
      list.push(item);
      await prisma.appConfiguration.update({ where: { shop }, data: { skuRequiredItems: JSON.stringify(list) } });
    }
  } else if (actionType === "removeSkuRequiredItem") {
    const item = formData.get("item") as string;
    const list = JSON.parse(config.skuRequiredItems || "[]").filter((i: string) => i !== item);
    await prisma.appConfiguration.update({ where: { shop }, data: { skuRequiredItems: JSON.stringify(list) } });
  } else if (actionType === "toggleEmailAlerts") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: { emailAlertsEnabled: formData.get("value") === "true" },
    });
  } else if (actionType === "addEmailAddress") {
    const newEmails = (formData.get("email") as string).split(',').map(e => e.trim()).filter(e => e);
    const existing = config.alertEmailAddress ? config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e) : [];
    const combined = Array.from(new Set([...existing, ...newEmails])).join(', ');
    await prisma.appConfiguration.update({
      where: { shop },
      data: { alertEmailAddress: combined },
    });
  } else if (actionType === "removeEmailAddress") {
    const emailToRemove = formData.get("email") as string;
    const existing = config.alertEmailAddress ? config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e) : [];
    const updated = existing.filter(e => e !== emailToRemove).join(', ');
    await prisma.appConfiguration.update({
      where: { shop },
      data: { alertEmailAddress: updated },
    });
  } else if (actionType === "addReason") {
    const reason = formData.get("reason") as string;
    const list = JSON.parse(config.adjustmentReasons || "[]");
    if (reason && !list.includes(reason)) {
      list.push(reason);
      await prisma.appConfiguration.update({ where: { shop }, data: { adjustmentReasons: JSON.stringify(list) } });
    }
  } else if (actionType === "seedReasons") {
    const seeds = ["New Inventory Received", "Cycle Count Correction", "Damaged Item", "Missing / Shrinkage", "Customer Return", "Outside Shopify Sale"];
    const list = JSON.parse(config.adjustmentReasons || "[]");
    for (const s of seeds) {
      if (!list.includes(s)) list.push(s);
    }
    await prisma.appConfiguration.update({ where: { shop }, data: { adjustmentReasons: JSON.stringify(list) } });
  } else if (actionType === "removeReason") {
    const reason = formData.get("reason") as string;
    const list = JSON.parse(config.adjustmentReasons || "[]").filter((r: string) => r !== reason);
    await prisma.appConfiguration.update({ where: { shop }, data: { adjustmentReasons: JSON.stringify(list) } });
  } else if (actionType === "toggleAlertReason") {
    const reason = formData.get("reason") as string;
    const value = formData.get("value") === "true";
    
    // Legacy support to keep config clean
    let list = JSON.parse(config.alertOnReasons || "[]");
    if (value && !list.includes(reason)) list.push(reason);
    if (!value) list = list.filter((r: string) => r !== reason);
    await prisma.appConfiguration.update({ where: { shop }, data: { alertOnReasons: JSON.stringify(list) } });

    // New rules engine support
    if (value) {
      const existingRule = await prisma.securityRule.findFirst({ where: { shop, triggerType: 'flagged_reason', name: reason } });
      if (!existingRule) {
        await prisma.securityRule.create({
          data: {
            shop,
            name: reason,
            description: `Alert triggered by flagged reason: ${reason}`,
            triggerType: 'flagged_reason',
            quantityThreshold: "0",
            isActive: true
          }
        });
      }
    } else {
      await prisma.securityRule.deleteMany({ where: { shop, triggerType: 'flagged_reason', name: reason } });
    }
  } else if (actionType === "updateReasonThreshold") {
    const reason = formData.get("reason") as string;
    const value = formData.get("value") as string;
    await prisma.securityRule.updateMany({
      where: { shop, triggerType: 'flagged_reason', name: reason },
      data: { quantityThreshold: value }
    });
  } else if (actionType === "createLowStockRule") {
    const threshold = formData.get("threshold") as string;
    const targetProductIds = formData.get("targetProductIds") as string; // JSON array or empty
    await prisma.securityRule.create({
      data: {
        shop,
        name: "Low Stock Alert",
        description: "Fires when inventory drops below the configured threshold.",
        triggerType: "low_stock",
        quantityThreshold: threshold || "10",
        targetProductIds: targetProductIds || null,
        isActive: true
      }
    });
  } else if (actionType === "updateLowStockRule") {
    const ruleId = formData.get("ruleId") as string;
    const threshold = formData.get("threshold") as string;
    const targetProductIds = formData.get("targetProductIds") as string;
    const isActive = formData.get("isActive") === "true";
    await prisma.securityRule.update({
      where: { id: ruleId },
      data: {
        quantityThreshold: threshold,
        targetProductIds: targetProductIds || null,
        isActive
      }
    });
  } else if (actionType === "deleteLowStockRule") {
    const ruleId = formData.get("ruleId") as string;
    await prisma.securityRule.delete({ where: { id: ruleId } });
  } else if (actionType === "togglePrivateEvidence") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: { privateEvidenceMode: formData.get("value") === "true" },
    });
  } else if (actionType === "updateMasterOverridePin") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: { masterOverridePin: formData.get("value") as string },
    });
  } else if (actionType === "updateDelegatedManagerPins") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: { delegatedManagerPins: formData.get("value") as string },
    });
  } else if (actionType === "addHighValueItem") {
    const item = formData.get("item") as string;
    const list = JSON.parse(config.highValueItems || "[]");
    if (item && !list.includes(item)) {
      list.push(item);
      await prisma.appConfiguration.update({ where: { shop }, data: { highValueItems: JSON.stringify(list) } });
    }
  } else if (actionType === "removeHighValueItem") {
    const item = formData.get("item") as string;
    const list = JSON.parse(config.highValueItems || "[]").filter((i: string) => i !== item);
    await prisma.appConfiguration.update({ where: { shop }, data: { highValueItems: JSON.stringify(list) } });
  } else if (actionType === "addSerialRequiredItem") {
    const item = formData.get("item") as string;
    const list = JSON.parse(config.serialNumberRequiredItems || "[]");
    if (!list.includes(item)) {
      list.push(item);
      await prisma.appConfiguration.update({ where: { shop }, data: { serialNumberRequiredItems: JSON.stringify(list) } });
    }
  } else if (actionType === "removeSerialRequiredItem") {
    const item = formData.get("item") as string;
    const list = JSON.parse(config.serialNumberRequiredItems || "[]").filter((i: string) => i !== item);
    await prisma.appConfiguration.update({ where: { shop }, data: { serialNumberRequiredItems: JSON.stringify(list) } });
  } else if (actionType === "updateMaxMagnitude") {
    const val = formData.get("value") as string;
    await prisma.appConfiguration.update({
      where: { shop },
      data: { maxAdjustmentMagnitude: val ? parseInt(val, 10) : null }
    });
  } else if (actionType === "addFrozenLocation") {
    const locId = formData.get("location") as string;
    const list = JSON.parse(config.frozenLocations || "[]");
    if (locId && !list.includes(locId)) list.push(locId);
    await prisma.appConfiguration.update({ where: { shop }, data: { frozenLocations: JSON.stringify(list) } });
  } else if (actionType === "removeFrozenLocation") {
    const locId = formData.get("location") as string;
    const list = JSON.parse(config.frozenLocations || "[]").filter((i: string) => i !== locId);
    await prisma.appConfiguration.update({ where: { shop }, data: { frozenLocations: JSON.stringify(list) } });
  } else if (actionType === "addReceiveOnlyStaff") {
    const staff = formData.get("staff") as string;
    const list = JSON.parse(config.receiveOnlyStaff || "[]");
    if (staff && !list.includes(staff)) list.push(staff);
    await prisma.appConfiguration.update({ where: { shop }, data: { receiveOnlyStaff: JSON.stringify(list) } });
  } else if (actionType === "removeReceiveOnlyStaff") {
    const staff = formData.get("staff") as string;
    const list = JSON.parse(config.receiveOnlyStaff || "[]").filter((i: string) => i !== staff);
    await prisma.appConfiguration.update({ where: { shop }, data: { receiveOnlyStaff: JSON.stringify(list) } });
  } else if (actionType === "toggleHardTimeFreeze") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: { hardFreezeOutsideHours: formData.get("value") === "true" }
    });
  } else if (actionType === "updateStaffLocationConstraint") {
    const staff = formData.get("staff") as string;
    const location = formData.get("location") as string;
    const isAdding = formData.get("isAdding") === "true";
    const constraints = JSON.parse(config.staffLocationConstraints || "{}");
    
    if (!constraints[staff]) constraints[staff] = [];
    
    if (isAdding && !constraints[staff].includes(location)) {
      constraints[staff].push(location);
    } else if (!isAdding) {
      constraints[staff] = constraints[staff].filter((l: string) => l !== location);
    }
    
    // Cleanup empty arrays
    if (constraints[staff].length === 0) delete constraints[staff];
    
    await prisma.appConfiguration.update({ where: { shop }, data: { staffLocationConstraints: JSON.stringify(constraints) } });
  } else if (actionType === "saveOnitVisionKey") {
    const key = formData.get("key") as string;
    // Validate the ONIT Vision API key
    const VALID_KEYS = ["GoogleDriveAccess123"];
    if (key && VALID_KEYS.includes(key)) {
      await prisma.appConfiguration.update({
        where: { shop },
        data: { onitVisionApiKey: key },
      });
      return json({ success: true, onitKeyValid: true });
    } else if (!key || key.trim() === '') {
      // Clear the key
      await prisma.appConfiguration.update({
        where: { shop },
        data: { onitVisionApiKey: null },
      });
      return json({ success: true, onitKeyValid: false });
    } else {
      return json({ success: false, error: "Invalid ONIT Financial Vision AI Key" });
    }
  } else if (actionType === "setEvidenceStorage") {
    const mode = formData.get("mode") as string;
    if (mode === "email" || mode === "google_drive") {
      await prisma.appConfiguration.update({
        where: { shop },
        data: { evidenceStorage: mode },
      });
    }
  } else if (actionType === "disconnectGoogleDrive") {
    await disconnectGoogleDrive(shop);
  } else if (actionType === "createApiKey") {
    const { generateApiKey } = await import("../services/api-auth.server");
    const name = formData.get("keyName") as string;
    const scope = formData.get("keyScope") as string || "read";
    if (!name) return json({ error: "Key name is required" }, { status: 400 });
    const key = generateApiKey();
    await prisma.apiKey.create({ data: { shop, name, key, scope, createdBy: 'Owner' } });
    return json({ success: true, newApiKey: key });
  } else if (actionType === "revokeApiKey") {
    const keyId = formData.get("keyId") as string;
    await prisma.apiKey.update({ where: { id: keyId }, data: { isActive: false } });
  } else if (actionType === "deleteApiKey") {
    const keyId = formData.get("keyId") as string;
    await prisma.apiKey.delete({ where: { id: keyId } });
  } else if (actionType === "savePoAuth") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: {
        poViewStaff: formData.get("poViewStaff") as string || "[]",
        poAuthorizedStaff: formData.get("poAuthorizedStaff") as string || "[]",
        poRequireApproval: formData.get("poRequireApproval") === "true",
        poAutoCreateOnLowStock: formData.get("poAutoCreateOnLowStock") === "true",
      }
    });
  } else if (actionType === "addPoAlertEmail") {
    const newEmails = (formData.get("email") as string).split(',').map(e => e.trim()).filter(e => e);
    const existing = config.poAlertEmails ? config.poAlertEmails.split(',').map(e => e.trim()).filter(e => e) : [];
    const combined = Array.from(new Set([...existing, ...newEmails])).join(', ');
    await prisma.appConfiguration.update({ where: { shop }, data: { poAlertEmails: combined } });
  } else if (actionType === "removePoAlertEmail") {
    const emailToRemove = formData.get("email") as string;
    const existing = config.poAlertEmails ? config.poAlertEmails.split(',').map(e => e.trim()).filter(e => e) : [];
    const updated = existing.filter(e => e !== emailToRemove).join(', ');
    await prisma.appConfiguration.update({ where: { shop }, data: { poAlertEmails: updated } });
  }

  return json({ success: true });
};

export default function Settings() {
  const { config, reasonRules, lowStockRules, variants, locations, staffMembers, apiKeys, googleAuthUrl } = useLoaderData<typeof loader>();
  const submit = useSubmit();

  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const [newHighValueItem, setNewHighValueItem] = useState("");
  const [newSerialItem, setNewSerialItem] = useState("");
  const [newFrozenLocation, setNewFrozenLocation] = useState("");
  const [newReceiveOnlyStaff, setNewReceiveOnlyStaff] = useState("");
  const [maxMagnitude, setMaxMagnitude] = useState(config.maxAdjustmentMagnitude ? config.maxAdjustmentMagnitude.toString() : "");
  const [newConstraintStaff, setNewConstraintStaff] = useState("");
  const [newConstraintLocation, setNewConstraintLocation] = useState("");

  // Low Stock Alert state
  const [lowStockThreshold, setLowStockThreshold] = useState("10");
  const [lowStockProductId, setLowStockProductId] = useState("");
  const [lowStockProductInput, setLowStockProductInput] = useState("");
  const [lowStockProductOptions, setLowStockProductOptions] = useState(variants);

  const updateLowStockProductText = useCallback(
    (value: string) => {
      setLowStockProductInput(value);
      if (value === '') { setLowStockProductOptions(variants); return; }
      const filterRegex = new RegExp(value, 'i');
      setLowStockProductOptions(variants.filter((v: any) => v.label.match(filterRegex)));
    }, [variants]
  );

  const [highValueInputValue, setHighValueInputValue] = useState("");
  const [highValueOptions, setHighValueOptions] = useState(variants);

  const updateHighValueText = useCallback(
    (value: string) => {
      setHighValueInputValue(value);
      if (value === '') {
        setHighValueOptions(variants);
        return;
      }
      const filterRegex = new RegExp(value, 'i');
      const resultOptions = variants.filter(
        (option: any) => option.label.match(filterRegex) || (option.sku && option.sku.match(filterRegex))
      );
      setHighValueOptions(resultOptions);
    },
    [variants]
  );

  const updateHighValueSelection = useCallback(
    (selected: string) => {
      const selectedValue = selected;
      const matchedOption = variants.find((option: any) => option.value === selectedValue);
      setNewHighValueItem(selectedValue);
      setHighValueInputValue(matchedOption ? matchedOption.label : '');
    },
    [variants]
  );

  const [serialInputValue, setSerialInputValue] = useState("");
  const [serialOptions, setSerialOptions] = useState(variants);

  const updateSerialText = useCallback(
    (value: string) => {
      setSerialInputValue(value);
      if (value === '') {
        setSerialOptions(variants);
        return;
      }
      const filterRegex = new RegExp(value, 'i');
      const resultOptions = variants.filter(
        (option: any) => option.label.match(filterRegex) || (option.sku && option.sku.match(filterRegex))
      );
      setSerialOptions(resultOptions);
    },
    [variants]
  );

  const updateSerialSelection = useCallback(
    (selected: string) => {
      const selectedValue = selected;
      const matchedOption = variants.find((option: any) => option.value === selectedValue);
      setNewSerialItem(selectedValue);
      setSerialInputValue(matchedOption ? matchedOption.label : '');
    },
    [variants]
  );

  const [masterOverridePin, setMasterOverridePin] = useState(config.masterOverridePin || "");
  const [newDelegatedManager, setNewDelegatedManager] = useState("");
  const [newDelegatedPin, setNewDelegatedPin] = useState("");

  const [newSkuItem, setNewSkuItem] = useState("");
  const [skuInputValue, setSkuInputValue] = useState("");
  const [skuOptions, setSkuOptions] = useState(variants);

  const updateSkuText = useCallback(
    (value: string) => {
      setSkuInputValue(value);
      if (value === '') {
        setSkuOptions(variants);
        return;
      }
      const filterRegex = new RegExp(value, 'i');
      const resultOptions = variants.filter(
        (option: any) => option.label.match(filterRegex) || (option.sku && option.sku.match(filterRegex))
      );
      setSkuOptions(resultOptions);
    },
    [variants]
  );

  const updateSkuSelection = useCallback(
    (selected: string) => {
      const selectedValue = selected;
      const matchedOption = variants.find((option: any) => option.value === selectedValue);
      setNewSkuItem(selectedValue);
      setSkuInputValue(matchedOption ? matchedOption.label : '');
    },
    [variants]
  );

  const filteredStaff1 = useMemo(() => {
    if (!newReceiveOnlyStaff) return staffMembers;
    const q = newReceiveOnlyStaff.toLowerCase();
    return staffMembers.filter((s: any) => s.name.toLowerCase().includes(q));
  }, [newReceiveOnlyStaff, staffMembers]);

  const filteredStaff2 = useMemo(() => {
    if (!newConstraintStaff) return staffMembers;
    const q = newConstraintStaff.toLowerCase();
    return staffMembers.filter((s: any) => s.name.toLowerCase().includes(q));
  }, [newConstraintStaff, staffMembers]);

  const constraints = config.staffLocationConstraints || {};

  useEffect(() => {
    const initial: Record<string, string> = {};
    if (reasonRules) {
      reasonRules.forEach((rule: any) => {
        initial[rule.name] = rule.quantityThreshold || "0";
      });
    }
    setThresholds(initial);
  }, [reasonRules]);

  const handleUpdateThreshold = (reason: string, val: string) => {
    setThresholds(prev => ({...prev, [reason]: val}));
  };

  const saveThreshold = (reason: string) => {
    submit({ actionType: "updateReasonThreshold", reason, value: thresholds[reason] || "0" }, { method: "post" });
  };

  const [newReason, setNewReason] = useState("");
  const [emailAddress, setEmailAddress] = useState(config.alertEmailAddress || "");
  const [onitKey, setOnitKey] = useState(config.onitVisionApiKey || "");
  const [onitKeyError, setOnitKeyError] = useState<string | null>(null);
  const [driveMessage, setDriveMessage] = useState<{type: 'success' | 'critical', text: string} | null>(null);

  // PO Alert Email state
  const [poAlertEmailInput, setPoAlertEmailInput] = useState("");
  const poAlertEmailList = useMemo(() => {
    return config?.poAlertEmails ? config.poAlertEmails.split(',').map((e: string) => e.trim()).filter((e: string) => e) : [];
  }, [config?.poAlertEmails]);

  // Determine if ONIT Vision key is valid (unlocks Google Drive)
  const isOnitKeyValid = config.onitVisionApiKey && config.onitVisionApiKey.length > 0;

  // Check URL params for Drive connection status
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('drive_connected') === 'true') {
      setDriveMessage({ type: 'success', text: 'Google Drive connected successfully! Evidence will now be stored privately in your Drive.' });
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('drive_error')) {
      const err = params.get('drive_error');
      setDriveMessage({ type: 'critical', text: err === 'denied' ? 'Google Drive authorization was denied.' : 'Failed to connect Google Drive. Please try again.' });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const handleAddReason = () => {
    submit({ actionType: "addReason", reason: newReason }, { method: "post" });
    setNewReason("");
  };

  const emailList = useMemo(() => {
    return config?.alertEmailAddress ? config.alertEmailAddress.split(',').map((e: string) => e.trim()).filter((e: string) => e) : [];
  }, [config?.alertEmailAddress]);

  const handleAddEmail = () => {
    submit({ actionType: "addEmailAddress", email: emailAddress }, { method: "post" });
    setEmailAddress("");
  };

  const { ENABLE_WMS_SUITE } = useOutletContext<any>();

  return (
    <Page title="App Settings">
      <Layout>
        {!ENABLE_WMS_SUITE && (
          <Layout.Section>
            <Banner
              title="Upgrade to Enterprise WMS Suite"
              action={{
                content: "Unlock WMS Features ($399/mo)",
                onAction: () => submit({ actionType: "upgradeToEnterprise" }, { method: "post" })
              }}
              tone="info"
            >
              <p>You are currently on the Dashboard Protection plan ($9.99/mo). Upgrade to the full Enterprise Warehouse Management Suite to unlock Inbound Receiving workflows, Outbound Pick & Pack workflows, Serial Number Tracking, and advanced magnitude freezes.</p>
            </Banner>
          </Layout.Section>
        )}

        <Layout.AnnotatedSection
          title="Setup Guide"
          description="Follow these 3 simple steps to secure your store and stop anonymous inventory changes."
        >
          <Card padding="400">
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Tooltip content="Removing default Shopify permissions forces your team to use this app for all inventory workflows.">
                  <Text variant="headingSm" as="h3"><span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Step 1: Block Normal Access</span></Text>
                </Tooltip>
                <Text as="p" variant="bodyMd">Go to Shopify Settings &rarr; <b>Users and permissions</b>. Uncheck the <b>Products/Inventory</b> box for your workers. This forces them to use this App so we can record who they are.</Text>
              </BlockStack>

              <BlockStack gap="100">
                <Tooltip content="When active, all manual adjustments automatically capture the worker's identity and require a valid reason.">
                  <Text variant="headingSm" as="h3"><span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Step 2: Enable Secure Inventory Mode</span></Text>
                </Tooltip>
                <Text as="p" variant="bodyMd">Turn ON the <b>Secure Inventory Mode</b> switch below. Workers must use this app to change inventory, and their Shopify identity is automatically captured.</Text>
              </BlockStack>

              <BlockStack gap="100">
                <Tooltip content="Requires physical evidence (photos/invoices) for all inbound stock receiving.">
                  <Text variant="headingSm" as="h3"><span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Step 3: Force Photo Proof</span></Text>
                </Tooltip>
                <Text as="p" variant="bodyMd">Turn ON the <b>Inbound Stock</b> switch below. Workers must upload a photo of the receipt when adding new stock.</Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Security Email Alerts"
          description="Instantly receive an email when an employee triggers a security alert (like a Supplier Mismatch)."
        >
          <Card padding="400">
            <BlockStack gap="400">
              <SettingToggle
                action={{
                  content: config.emailAlertsEnabled ? 'Disable' : 'Enable',
                  onAction: () => submit({ actionType: "toggleEmailAlerts", value: config.emailAlertsEnabled ? "false" : "true" }, { method: "post" }),
                }}
                enabled={config.emailAlertsEnabled}
              >
                Email Alerts are currently <Text variant="bodyMd" fontWeight="bold" as="span">{config.emailAlertsEnabled ? 'Enabled' : 'Disabled'}</Text>.
              </SettingToggle>

              {config.emailAlertsEnabled && (
                <>
                  <Tooltip content="The addresses that will receive instant alerts for triggered security events.">
                    <Text as="h3" variant="headingMd"><span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Destination Email Address(es)</span></Text>
                  </Tooltip>
                  <Text as="p" variant="bodyMd">Where should we send the security alerts? Add one email at a time or you can add multiple emails at once by separating them with a comma.</Text>
                  <BlockStack gap="300">
                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      <div style={{ flexGrow: 1 }}>
                        <TextField 
                          label="Email Address" 
                          labelHidden 
                          value={emailAddress} 
                          onChange={setEmailAddress} 
                          autoComplete="email" 
                          placeholder="owner@mystore.com, loss-prevention@mystore.com" 
                        />
                      </div>
                      <Button onClick={handleAddEmail} disabled={!emailAddress.trim()}>Add</Button>
                    </InlineStack>
                    
                    {emailList.length > 0 && (
                      <InlineStack gap="200">
                        {emailList.map((email: string) => (
                          <Tag key={email} onRemove={() => submit({ actionType: "removeEmailAddress", email }, { method: "post" })}>
                            {email}
                          </Tag>
                        ))}
                      </InlineStack>
                    )}
                  </BlockStack>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Evidence Privacy"
          description="Control how evidence files (photos, packing slips, invoices) are handled when alerts fire."
        >
          <Card padding="400">
            <BlockStack gap="400">
              <SettingToggle
                action={{
                  content: config.privateEvidenceMode ? 'Disable' : 'Enable',
                  onAction: () => submit({ actionType: "togglePrivateEvidence", value: config.privateEvidenceMode ? "false" : "true" }, { method: "post" }),
                }}
                enabled={config.privateEvidenceMode}
              >
                Private Evidence Mode is currently <Text variant="bodyMd" fontWeight="bold" as="span">{config.privateEvidenceMode ? 'Enabled' : 'Disabled'}</Text>.
              </SettingToggle>

              {config.privateEvidenceMode ? (
                <BlockStack gap="300">
                  <Banner tone="success" title="Evidence is Private">
                    <p>Alert emails will <strong>not</strong> include file links or attachments. Instead, they reference the Shopify transaction number and link directly to the evidence viewer inside this app. Only authenticated Shopify admin users can view the files. With Private Evidence Mode enabled, you must log into this app to view evidence — you cannot see photos or documents directly from the email. If you forward an alert to an auditor, lawyer, or supplier, they will not be able to see the evidence unless you grant them Shopify admin access or export the files manually.</p>
                  </Banner>
                </BlockStack>
              ) : (
                <BlockStack gap="300">
                  <Banner tone="info" title="Evidence is Accessible via Direct Links">
                    <p>Alert emails will include direct, unlisted links to evidence files. The benefit of this mode is that links are public but not searchable or exposed — only the email recipients can actually click on this link given its secure, randomized address. The efficiency of real links makes this an excellent option to get things done quickly. You or any forwarded recipients (like auditors or suppliers) can view packing slips and photos instantly without needing Shopify admin access.</p>
                  </Banner>
                </BlockStack>
              )}

              {/* ONIT Financial Vision AI — subtle upsell at the bottom */}
              <Divider />
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">ONIT Financial Vision AI</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Have an ONIT Financial Vision AI key? Enter it to unlock Google Drive evidence mirroring, automated invoice OCR, and ERP integration.
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <TextField
                    label="ONIT Vision API Key"
                    labelHidden
                    value={onitKey}
                    onChange={(v) => { setOnitKey(v); setOnitKeyError(null); }}
                    autoComplete="off"
                    placeholder="Enter your ONIT Vision API Key"
                    type="password"
                  />
                  <Button
                    onClick={() => {
                      setOnitKeyError(null);
                      submit({ actionType: "saveOnitVisionKey", key: onitKey }, { method: "post" });
                    }}
                    disabled={onitKey === (config.onitVisionApiKey || "")}
                    size="slim"
                  >
                    Validate
                  </Button>
                </InlineStack>

                {onitKeyError && (
                  <Banner tone="critical"><p>{onitKeyError}</p></Banner>
                )}

                {/* Google Drive — only visible with valid ONIT key */}
                {isOnitKeyValid && (
                  <BlockStack gap="300">
                    <Banner tone="success" title="✅ ONIT Vision AI Active">
                      <p>Google Drive evidence mirroring is available.</p>
                    </Banner>

                    {driveMessage && (
                      <Banner tone={driveMessage.type} onDismiss={() => setDriveMessage(null)}>
                        <p>{driveMessage.text}</p>
                      </Banner>
                    )}

                    {config.googleDriveEnabled ? (
                      <Card background="bg-surface-success">
                        <BlockStack gap="300">
                          <Text as="h3" variant="headingSm">✅ Google Drive Connected</Text>
                          {config.googleDriveEmail && (
                            <Text as="p" variant="bodySm">Connected as: <Text as="span" fontWeight="bold">{config.googleDriveEmail}</Text></Text>
                          )}
                          <InlineStack gap="200">
                            <Button
                              variant={config.evidenceStorage === 'google_drive' ? 'primary' : undefined}
                              size="slim"
                              onClick={() => submit({ actionType: 'setEvidenceStorage', mode: 'google_drive' }, { method: 'post' })}
                            >
                              🔒 Mirror to Drive
                            </Button>
                            <Button
                              variant={config.evidenceStorage === 'email' ? 'primary' : undefined}
                              size="slim"
                              onClick={() => submit({ actionType: 'setEvidenceStorage', mode: 'email' }, { method: 'post' })}
                            >
                              📧 Shopify Only
                            </Button>
                          </InlineStack>
                          <Button
                            tone="critical"
                            variant="plain"
                            onClick={() => {
                              if (confirm('Disconnect Google Drive? Existing files in your Drive will not be deleted.')) {
                                submit({ actionType: 'disconnectGoogleDrive' }, { method: 'post' });
                              }
                            }}
                          >
                            Disconnect Google Drive
                          </Button>
                        </BlockStack>
                      </Card>
                    ) : (
                      <InlineStack gap="200" blockAlign="center">
                        <Button variant="primary" url={googleAuthUrl} external size="slim">
                          Connect Google Drive
                        </Button>
                        <Text as="p" variant="bodySm" tone="subdued">
                          We only access files we create — never your other Drive files.
                        </Text>
                      </InlineStack>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Secure Inventory Mode"
          description="Force all inventory changes through this app. Each adjustment is automatically logged with the authenticated Shopify user's identity."
        >
          <Card padding="400">
            <BlockStack gap="400">
              <SettingToggle
                action={{
                  content: config.strictInventory ? 'Disable' : 'Enable',
                  onAction: () => submit({ actionType: "toggleStrict", value: config.strictInventory ? "false" : "true" }, { method: "post" }),
                }}
                enabled={config.strictInventory}
              >
                Secure Inventory Mode is currently <Text variant="bodyMd" fontWeight="bold" as="span">{config.strictInventory ? 'Enabled' : 'Disabled'}</Text>.
              </SettingToggle>

              {config.strictInventory && (
                <Banner tone="success" title="Accountability is Automatic">
                  <p>Workers must use this app to make inventory changes. Their Shopify login identity is automatically captured on every adjustment — no manual name lists needed.</p>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {config.strictInventory && (
          <>
            {ENABLE_WMS_SUITE && (
              <>
            <Layout.AnnotatedSection
              title="Inbound Documentation"
              description="Require workers to identify the supplier and provide at least one reference number (PO, Invoice, or Packing Slip) plus photo proof when receiving new inventory."
            >
              <Card padding="400">
                <BlockStack gap="400">
                  <SettingToggle
                    action={{
                      content: config.requireInboundReference ? 'Make Optional' : 'Make Required',
                      onAction: () => submit({ actionType: "toggleRequireInbound", value: config.requireInboundReference ? "false" : "true" }, { method: "post" }),
                    }}
                    enabled={config.requireInboundReference}
                  >
                    Inbound documentation is currently <Text variant="bodyMd" fontWeight="bold" as="span">{config.requireInboundReference ? 'Required' : 'Optional'}</Text>.
                  </SettingToggle>

                  {config.requireInboundReference && (
                    <Banner tone="info">
                      <p>When adding inventory, workers must enter the <strong>supplier name</strong>, at least one <strong>reference number</strong> (PO, Invoice, or Packing Slip), and upload photo proof of the documentation.</p>
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Mandatory SKU Scanning"
              description="Force workers to physically scan the barcode (SKU) when adjusting inventory, ensuring they have the correct item. They can bypass this by entering a reason, which triggers an alert."
            >
              <Card padding="400">
                <BlockStack gap="400">
                  <SettingToggle
                    action={{
                      content: config.requireSkuScanAll ? 'Make Optional' : 'Mandate for ALL Products',
                      onAction: () => submit({ actionType: "toggleRequireSkuScanAll", value: config.requireSkuScanAll ? "false" : "true" }, { method: "post" }),
                    }}
                    enabled={config.requireSkuScanAll}
                  >
                    Global SKU Scanning is currently <Text variant="bodyMd" fontWeight="bold" as="span">{config.requireSkuScanAll ? 'Required (All Products)' : 'Optional'}</Text>.
                  </SettingToggle>

                  {!config.requireSkuScanAll && (
                    <BlockStack gap="400">
                      <Divider />
                      <Text as="h3" variant="headingMd">Mandate Specific Products Only</Text>
                      <p>If global scanning is off, you can still require it for specific items.</p>
                      {config.skuRequiredItems && config.skuRequiredItems.length > 0 ? (
                        <BlockStack gap="200">
                          {config.skuRequiredItems.map((itemId: string) => {
                            const variant = variants.find((v: any) => v.value === itemId);
                            const label = variant ? variant.label : `Item ID: ${itemId}`;
                            return (
                              <InlineStack key={itemId} blockAlign="center" gap="400">
                                <Tag onRemove={() => submit({ actionType: "removeSkuRequiredItem", item: itemId }, { method: "post" })}>
                                  {label}
                                </Tag>
                              </InlineStack>
                            );
                          })}
                        </BlockStack>
                      ) : (
                        <Text as="p" tone="subdued">No specific items require SKU scanning yet.</Text>
                      )}
                      
                      <InlineStack gap="200" blockAlign="center">
                        <div style={{ flexGrow: 1 }}>
                          <Autocomplete
                            options={skuOptions}
                            selected={[newSkuItem]}
                            onSelect={(selected) => updateSkuSelection(selected[0])}
                            textField={
                              <Autocomplete.TextField
                                onChange={updateSkuText}
                                label="Select Item"
                                labelHidden
                                value={skuInputValue}
                                prefix={<Icon source={SearchIcon} />}
                                placeholder="Search product name or SKU..."
                                autoComplete="off"
                                clearButton
                                onClearButtonClick={() => {
                                  setSkuInputValue('');
                                  setNewSkuItem('');
                                }}
                              />
                            }
                          />
                        </div>
                        <Button 
                          onClick={() => {
                            submit({ actionType: "addSkuRequiredItem", item: newSkuItem }, { method: "post" });
                            setNewSkuItem("");
                            setSkuInputValue("");
                          }} 
                          disabled={!newSkuItem}
                        >
                          Require SKU Scan
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
            </>
            )}

          <Layout.AnnotatedSection
            title="Adjustment Reasons"
            description="Manage the list of predefined reasons for inventory changes."
          >
            <Card padding="400">
              <BlockStack gap="400">
                <SettingToggle
                  action={{
                    content: config.requireDetailedReason ? 'Make Optional' : 'Make Required',
                    onAction: () => submit({ actionType: "toggleRequireDetailedReason", value: config.requireDetailedReason ? "false" : "true" }, { method: "post" }),
                  }}
                  enabled={config.requireDetailedReason}
                >
                  Workers must type a detailed explanation (at least 3 words) is currently <Text variant="bodyMd" fontWeight="bold" as="span">{config.requireDetailedReason ? 'Required' : 'Optional'}</Text>.
                </SettingToggle>

                {config.requireDetailedReason && (
                  <Banner tone="info">
                    <p>In addition to selecting a reason from the list, workers will be forced to type a detailed explanation of why the inventory is being adjusted. The explanation must be at least 3 words long.</p>
                  </Banner>
                )}

                <Text as="h3" variant="headingMd">Allowed Reasons</Text>
                <BlockStack gap="200">
                  {config.adjustmentReasons.map((r: string) => {
                    const isAlerted = config.alertOnReasons.includes(r);
                    return (
                      <InlineStack key={r} blockAlign="center" gap="400">
                        <Tag onRemove={() => submit({ actionType: "removeReason", reason: r }, { method: "post" })}>
                          {r}
                        </Tag>
                        <Checkbox
                          label="Trigger Alert"
                          checked={isAlerted}
                          onChange={(val) => submit({ actionType: "toggleAlertReason", reason: r, value: val.toString() }, { method: "post" })}
                        />
                        {isAlerted && (
                          <div style={{ width: '120px' }}>
                            <TextField
                              label="Alert if changed >"
                              labelHidden={false}
                              type="number"
                              min={0}
                              value={thresholds[r] !== undefined ? thresholds[r] : "0"}
                              onChange={(val) => handleUpdateThreshold(r, val)}
                              onBlur={() => saveThreshold(r)}
                              autoComplete="off"
                            />
                          </div>
                        )}
                      </InlineStack>
                    );
                  })}
                </BlockStack>
                <InlineStack gap="200" blockAlign="center">
                  <TextField label="Add Reason" labelHidden value={newReason} onChange={setNewReason} autoComplete="off" placeholder="e.g. Stolen" />
                  <Button onClick={handleAddReason} disabled={!newReason}>Add</Button>
                  <Button variant="plain" onClick={() => submit({ actionType: "seedReasons" }, { method: "post" })}>Seed Top 5</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Low Stock Alerts"
            description="Get notified when inventory drops below a threshold. Configure per-product or global alerts."
          >
            <Card padding="400">
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">Active Low Stock Rules</Text>
                {lowStockRules.length > 0 ? (
                  <BlockStack gap="200">
                    {lowStockRules.map((rule: any) => {
                      const targetIds = rule.targetProductIds ? JSON.parse(rule.targetProductIds) : [];
                      const targetLabel = targetIds.length > 0
                        ? targetIds.map((id: string) => {
                            const found = variants.find((v: any) => v.value === `gid://shopify/InventoryItem/${id}` || v.value === id);
                            return found ? found.label : `Item ${id}`;
                          }).join(', ')
                        : 'All Products';
                      return (
                        <InlineStack key={rule.id} align="space-between" blockAlign="center">
                          <BlockStack gap="100">
                            <Text as="span" variant="bodyMd" fontWeight="bold">
                              {rule.isActive ? '🟢' : '🔴'} Threshold: ≤ {rule.quantityThreshold} units
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">{targetLabel}</Text>
                          </BlockStack>
                          <InlineStack gap="200">
                            <Button
                              size="slim"
                              onClick={() => {
                                const fd = new FormData();
                                fd.append('actionType', 'updateLowStockRule');
                                fd.append('ruleId', rule.id);
                                fd.append('threshold', rule.quantityThreshold);
                                fd.append('targetProductIds', rule.targetProductIds || '');
                                fd.append('isActive', rule.isActive ? 'false' : 'true');
                                submit(fd, { method: 'post' });
                              }}
                            >
                              {rule.isActive ? 'Disable' : 'Enable'}
                            </Button>
                            <Button
                              size="slim"
                              tone="critical"
                              onClick={() => {
                                const fd = new FormData();
                                fd.append('actionType', 'deleteLowStockRule');
                                fd.append('ruleId', rule.id);
                                submit(fd, { method: 'post' });
                              }}
                            >
                              Remove
                            </Button>
                          </InlineStack>
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                ) : (
                  <Banner tone="info">
                    <p>No low stock alerts configured. Add one below to get notified when inventory runs low.</p>
                  </Banner>
                )}

                <Text as="h3" variant="headingMd">Add New Low Stock Alert</Text>
                <FormLayout>
                  <TextField
                    label="Alert when stock drops to or below"
                    type="number"
                    value={lowStockThreshold}
                    onChange={setLowStockThreshold}
                    suffix="units"
                    autoComplete="off"
                  />
                  <Combobox
                    activator={
                      <Combobox.TextField
                        label="Monitor specific product (leave empty for all products)"
                        value={lowStockProductInput}
                        onChange={updateLowStockProductText}
                        placeholder="Search products..."
                        autoComplete="off"
                      />
                    }
                  >
                    {lowStockProductOptions.length > 0 ? (
                      <Listbox onSelect={(selected) => {
                        setLowStockProductId(selected);
                        const found = variants.find((v: any) => v.value === selected);
                        setLowStockProductInput(found ? found.label : selected);
                      }}>
                        {lowStockProductOptions.map((opt: any) => (
                          <Listbox.Option key={opt.value} value={opt.value}>{opt.label}</Listbox.Option>
                        ))}
                      </Listbox>
                    ) : null}
                  </Combobox>
                  <Button
                    variant="primary"
                    onClick={() => {
                      const fd = new FormData();
                      fd.append('actionType', 'createLowStockRule');
                      fd.append('threshold', lowStockThreshold);
                      if (lowStockProductId) {
                        const numericId = lowStockProductId.replace('gid://shopify/InventoryItem/', '');
                        fd.append('targetProductIds', JSON.stringify([numericId]));
                      }
                      submit(fd, { method: 'post' });
                      setLowStockThreshold('10');
                      setLowStockProductId('');
                      setLowStockProductInput('');
                    }}
                  >
                    Add Low Stock Alert
                  </Button>
                </FormLayout>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="High Value Sacred Items"
            description="Select inventory items that are extremely valuable. Staff will be blocked from manually adjusting these items, and an immediate alert will be sent to the owner if they attempt to do so."
          >
            <Card padding="400">
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">Protected Inventory</Text>
                {config.highValueItems.length > 0 ? (
                  <BlockStack gap="200">
                    {config.highValueItems.map((itemId: string) => {
                      const variant = variants.find((v: any) => v.value === itemId);
                      const label = variant ? variant.label : `Item ID: ${itemId}`;
                      return (
                        <InlineStack key={itemId} blockAlign="center" gap="400">
                          <Tag onRemove={() => submit({ actionType: "removeHighValueItem", item: itemId }, { method: "post" })}>
                            {label}
                          </Tag>
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                ) : (
                  <Text as="p" tone="subdued">No high value items selected yet.</Text>
                )}
                
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ flexGrow: 1 }}>
                    <Autocomplete
                      options={highValueOptions}
                      selected={[newHighValueItem]}
                      onSelect={(selected) => updateHighValueSelection(selected[0])}
                      textField={
                        <Autocomplete.TextField
                          onChange={updateHighValueText}
                          label="Select Item"
                          labelHidden
                          value={highValueInputValue}
                          prefix={<Icon source={SearchIcon} />}
                          placeholder="Search product name or SKU..."
                          autoComplete="off"
                          clearButton
                          onClearButtonClick={() => {
                            setHighValueInputValue('');
                            setNewHighValueItem('');
                          }}
                        />
                      }
                    />
                  </div>
                  <Button 
                    onClick={() => {
                      submit({ actionType: "addHighValueItem", item: newHighValueItem }, { method: "post" });
                      setNewHighValueItem("");
                      setHighValueInputValue("");
                    }} 
                    disabled={!newHighValueItem}
                  >
                    Protect Item
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {ENABLE_WMS_SUITE && (
          <Layout.AnnotatedSection
            title="Serial Number Required Items"
            description="Items placed here will require the worker to scan or manually enter the exact serial number for EVERY unit picked before they can proceed. They will not be able to just click '+1 Manual'."
          >
            <Card padding="400">
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">Serialized Inventory</Text>
                {config.serialNumberRequiredItems && config.serialNumberRequiredItems.length > 0 ? (
                  <BlockStack gap="200">
                    {config.serialNumberRequiredItems.map((itemId: string) => {
                      const variant = variants.find((v: any) => v.value === itemId);
                      const label = variant ? variant.label : `Item ID: ${itemId}`;
                      return (
                        <InlineStack key={itemId} blockAlign="center" gap="400">
                          <Tag onRemove={() => submit({ actionType: "removeSerialRequiredItem", item: itemId }, { method: "post" })}>
                            {label}
                          </Tag>
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                ) : (
                  <Text as="p" tone="subdued">No items require serial numbers yet.</Text>
                )}
                
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ flexGrow: 1 }}>
                    <Autocomplete
                      options={serialOptions}
                      selected={[newSerialItem]}
                      onSelect={(selected) => updateSerialSelection(selected[0])}
                      textField={
                        <Autocomplete.TextField
                          onChange={updateSerialText}
                          label="Select Item"
                          labelHidden
                          value={serialInputValue}
                          prefix={<Icon source={SearchIcon} />}
                          placeholder="Search product name or SKU..."
                          autoComplete="off"
                          clearButton
                          onClearButtonClick={() => {
                            setSerialInputValue('');
                            setNewSerialItem('');
                          }}
                        />
                      }
                    />
                  </div>
                  <Button 
                    onClick={() => {
                      submit({ actionType: "addSerialRequiredItem", item: newSerialItem }, { method: "post" });
                      setNewSerialItem("");
                      setSerialInputValue("");
                    }} 
                    disabled={!newSerialItem}
                  >
                    Require Serial #
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
          )}

          {ENABLE_WMS_SUITE && (
            <>
          <Layout.AnnotatedSection
            title="Enterprise Security Freezes"
            description="Configure advanced hard blocks to prevent disastrous inventory adjustments. These rules will completely block staff from making changes that violate the policies."
          >
            <Card padding="400">
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">1. Magnitude Freezing (Fat Finger Block)</Text>
                <p>Prevent accidentally large adjustments (e.g., typing 500 instead of 50). Any adjustment larger than this magnitude (positive or negative) will be strictly blocked.</p>
                <InlineStack gap="400" blockAlign="center">
                  <div style={{ width: '150px' }}>
                    <TextField 
                      label="Max Magnitude Limit" 
                      type="number"
                      value={maxMagnitude} 
                      onChange={setMaxMagnitude}
                      onBlur={() => submit({ actionType: "updateMaxMagnitude", value: maxMagnitude }, { method: "post" })}
                      autoComplete="off" 
                      placeholder="e.g. 50"
                    />
                  </div>
                  <Text as="span" tone="subdued">Leave blank to disable magnitude limits.</Text>
                </InlineStack>

                <Divider />

                <Text as="h3" variant="headingMd">2. Location-Based Freezing (Quarantine Zone)</Text>
                <p>Select entire Shopify locations where inventory is completely locked from manual adjustments.</p>
                <BlockStack gap="200">
                  {config.frozenLocations.map((locId: string) => {
                    const loc = locations.find((l: any) => l.id === locId);
                    return (
                      <InlineStack key={locId} blockAlign="center" gap="400">
                        <Tag onRemove={() => submit({ actionType: "removeFrozenLocation", location: locId }, { method: "post" })}>
                          {loc ? loc.name : locId}
                        </Tag>
                      </InlineStack>
                    );
                  })}
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ flexGrow: 1 }}>
                      <Select
                        label="Select Location"
                        labelHidden
                        options={[{ label: "Select a location to freeze...", value: "" }, ...locations.map((l: any) => ({ label: l.name, value: l.id }))]}
                        value={newFrozenLocation}
                        onChange={setNewFrozenLocation}
                      />
                    </div>
                    <Button onClick={() => { submit({ actionType: "addFrozenLocation", location: newFrozenLocation }, { method: "post" }); setNewFrozenLocation(""); }} disabled={!newFrozenLocation}>
                      Freeze Location
                    </Button>
                  </InlineStack>
                </BlockStack>

                <Divider />

                <Text as="h3" variant="headingMd">3. Directional Freezing (Receive-Only Staff)</Text>
                <p>Designate specific staff members who are only allowed to add inventory (+). They will be blocked from logging negative (-) shrinkages or write-offs.</p>
                <BlockStack gap="200">
                  {config.receiveOnlyStaff.map((staff: string) => (
                    <InlineStack key={staff} blockAlign="center" gap="400">
                      <Tag onRemove={() => submit({ actionType: "removeReceiveOnlyStaff", staff }, { method: "post" })}>
                        {staff}
                      </Tag>
                    </InlineStack>
                  ))}
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ flexGrow: 1 }}>
                      <Combobox
                        activator={
                          <Combobox.TextField
                            onChange={setNewReceiveOnlyStaff}
                            label="Staff Member"
                            labelHidden
                            value={newReceiveOnlyStaff}
                            placeholder="Type or select a staff name..."
                            autoComplete="off"
                          />
                        }
                      >
                        {filteredStaff1.length > 0 ? (
                          <Listbox onSelect={(val) => setNewReceiveOnlyStaff(val)}>
                            {filteredStaff1.map((s: any) => (
                              <Listbox.Option key={s.name} value={s.name}>
                                {s.name}
                              </Listbox.Option>
                            ))}
                          </Listbox>
                        ) : null}
                      </Combobox>
                    </div>
                    <Button onClick={() => { submit({ actionType: "addReceiveOnlyStaff", staff: newReceiveOnlyStaff }, { method: "post" }); setNewReceiveOnlyStaff(""); }} disabled={!newReceiveOnlyStaff}>
                      Add to List
                    </Button>
                  </InlineStack>
                </BlockStack>

                <Divider />

                <Text as="h3" variant="headingMd">4. Time-Based Hard Freezing</Text>
                <p>Strictly block any manual inventory adjustments outside of normal business hours.</p>
                <SettingToggle
                  action={{
                    content: config.hardFreezeOutsideHours ? 'Disable Hard Freeze' : 'Enable Hard Freeze',
                    onAction: () => submit({ actionType: "toggleHardTimeFreeze", value: config.hardFreezeOutsideHours ? "false" : "true" }, { method: "post" }),
                  }}
                  enabled={config.hardFreezeOutsideHours}
                >
                  Operating Hours Lock is currently <Text variant="bodyMd" fontWeight="bold" as="span">{config.hardFreezeOutsideHours ? 'Enabled' : 'Disabled'}</Text>.
                </SettingToggle>

                <Divider />

                <Text as="h3" variant="headingMd">5. Staff Location Constraints (Dropdown Visibility)</Text>
                <p>Restrict specific employees to only see and select certain warehouse locations. If an employee is added here, they will ONLY see the locations assigned to them in the Adjustment dropdown.</p>
                <BlockStack gap="400">
                  {Object.entries(constraints).map(([staff, locIds]: [string, any]) => (
                    <Box key={staff} padding="200" background="bg-surface-secondary" borderRadius="100">
                      <BlockStack gap="200">
                        <Text variant="headingSm" as="h4">Employee: {staff}</Text>
                        <InlineStack gap="200" blockAlign="center">
                          {locIds.map((locId: string) => {
                            const loc = locations.find((l: any) => l.id === locId);
                            return (
                              <Tag key={locId} onRemove={() => submit({ actionType: "updateStaffLocationConstraint", staff, location: locId, isAdding: "false" }, { method: "post" })}>
                                {loc ? loc.name : locId}
                              </Tag>
                            );
                          })}
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  ))}
                  
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ flexGrow: 1 }}>
                      <Combobox
                        activator={
                          <Combobox.TextField
                            onChange={setNewConstraintStaff}
                            label="Staff Member"
                            labelHidden
                            value={newConstraintStaff}
                            placeholder="Type or select a staff name..."
                            autoComplete="off"
                          />
                        }
                      >
                        {filteredStaff2.length > 0 ? (
                          <Listbox onSelect={(val) => setNewConstraintStaff(val)}>
                            {filteredStaff2.map((s: any) => (
                              <Listbox.Option key={s.name} value={s.name}>
                                {s.name}
                              </Listbox.Option>
                            ))}
                          </Listbox>
                        ) : null}
                      </Combobox>
                    </div>
                    <div style={{ flexGrow: 1 }}>
                      <Select
                        label="Allowed Location"
                        labelHidden
                        options={[{ label: "Select a location to allow...", value: "" }, ...locations.map((l: any) => ({ label: l.name, value: l.id }))]}
                        value={newConstraintLocation}
                        onChange={setNewConstraintLocation}
                      />
                    </div>
                    <Button 
                      onClick={() => { 
                        submit({ actionType: "updateStaffLocationConstraint", staff: newConstraintStaff, location: newConstraintLocation, isAdding: "true" }, { method: "post" }); 
                        setNewConstraintLocation(""); 
                      }} 
                      disabled={!newConstraintStaff || !newConstraintLocation}
                    >
                      Allow Location
                    </Button>
                  </InlineStack>
                </BlockStack>

              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Manager Override Delegation"
            description="Configure the PINs used to override halted transactions (e.g., unauthorized returns or inbound overages)."
          >
            <Card padding="400">
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">Master Override PIN</Text>
                <Text as="p">This is the global fallback PIN that can override any hard block.</Text>
                <InlineStack gap="400" blockAlign="center">
                  <div style={{ width: '150px' }}>
                    <TextField
                      label="Master PIN"
                      labelHidden
                      type="password"
                      value={masterOverridePin}
                      onChange={setMasterOverridePin}
                      autoComplete="off"
                      placeholder="e.g., 1234"
                    />
                  </div>
                  <Button 
                    onClick={() => {
                      submit({ actionType: "updateMasterOverridePin", value: masterOverridePin }, { method: "post" });
                    }} 
                  >
                    Save PIN
                  </Button>
                </InlineStack>

                <Divider />

                <Text as="h3" variant="headingMd">Delegated Staff PINs</Text>
                <Text as="p">Assign specific PINs to trusted staff members. Their identity will be logged when they perform an override.</Text>
                
                <Box background="bg-surface-secondary" padding="300" borderRadius="100">
                  <BlockStack gap="200">
                    {Object.entries(config.delegatedManagerPins).map(([staffName, pin]) => (
                      <InlineStack key={staffName} gap="200" blockAlign="center" align="space-between">
                        <Text as="span">{staffName}</Text>
                        <InlineStack gap="200">
                          <Text as="span" tone="subdued">****</Text>
                          <Button 
                            tone="critical" 
                            variant="plain"
                            onClick={() => {
                              const updated = { ...config.delegatedManagerPins };
                              delete updated[staffName];
                              submit({ actionType: "updateDelegatedManagerPins", value: JSON.stringify(updated) }, { method: "post" });
                            }}
                          >
                            Remove
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    ))}
                    {Object.keys(config.delegatedManagerPins).length === 0 && (
                      <Text as="p" tone="subdued">No staff have been assigned a manager PIN.</Text>
                    )}
                  </BlockStack>
                </Box>

                <InlineStack gap="200" blockAlign="center">
                  <div style={{ flexGrow: 1 }}>
                    <Combobox
                      activator={
                        <Combobox.TextField
                          onChange={setNewDelegatedManager}
                          label="Staff Member"
                          labelHidden
                          value={newDelegatedManager}
                          placeholder="Select staff name..."
                          autoComplete="off"
                        />
                      }
                    >
                      {filteredStaff2.length > 0 ? (
                        <Listbox onSelect={(val) => setNewDelegatedManager(val)}>
                          {filteredStaff2.map((s: any) => (
                            <Listbox.Option key={s.name} value={s.name}>
                              {s.name}
                            </Listbox.Option>
                          ))}
                        </Listbox>
                      ) : null}
                    </Combobox>
                  </div>
                  <div style={{ width: '150px' }}>
                    <TextField
                      label="Staff PIN"
                      labelHidden
                      type="password"
                      value={newDelegatedPin}
                      onChange={setNewDelegatedPin}
                      autoComplete="off"
                      placeholder="PIN"
                    />
                  </div>
                  <Button 
                    onClick={() => { 
                      const updated = { ...config.delegatedManagerPins, [newDelegatedManager]: newDelegatedPin };
                      submit({ actionType: "updateDelegatedManagerPins", value: JSON.stringify(updated) }, { method: "post" });
                      setNewDelegatedManager("");
                      setNewDelegatedPin("");
                    }} 
                    disabled={!newDelegatedManager || !newDelegatedPin}
                  >
                    Assign
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
            </>
          )}
          </>
        )}
          {/* PO Authorization Controls */}
          <Layout.AnnotatedSection
            title="📋 Purchase Order Authorization"
            description="Control who can view, create, and manage purchase orders."
          >
            <Card>
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">PO View Access</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Only these staff members can see the Purchase Orders page. Leave empty to allow all staff.
                </Text>
                <InlineStack gap="200" wrap>
                  {config.poViewStaff.map((name: string) => (
                    <Tag key={name} onRemove={() => {
                      const updated = config.poViewStaff.filter((n: string) => n !== name);
                      submit({ actionType: "savePoAuth", poViewStaff: JSON.stringify(updated), poAuthorizedStaff: JSON.stringify(config.poAuthorizedStaff), poRequireApproval: config.poRequireApproval ? "true" : "false", poAutoCreateOnLowStock: config.poAutoCreateOnLowStock ? "true" : "false" }, { method: "post" });
                    }}>{name}</Tag>
                  ))}
                </InlineStack>
                <Select label="Add staff to PO view access" options={[{ label: "Select...", value: "" }, ...staffMembers.map((s: any) => ({ label: s.name, value: s.name }))]} value="" onChange={(v) => {
                  if (v && !config.poViewStaff.includes(v)) {
                    const updated = [...config.poViewStaff, v];
                    submit({ actionType: "savePoAuth", poViewStaff: JSON.stringify(updated), poAuthorizedStaff: JSON.stringify(config.poAuthorizedStaff), poRequireApproval: config.poRequireApproval ? "true" : "false", poAutoCreateOnLowStock: config.poAutoCreateOnLowStock ? "true" : "false" }, { method: "post" });
                  }
                }} />

                <Divider />
                <Text as="h3" variant="headingMd">PO Creation Authorization</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Only these staff members can create draft Purchase Orders. Leave empty to allow all PO viewers.
                </Text>
                <InlineStack gap="200" wrap>
                  {config.poAuthorizedStaff.map((name: string) => (
                    <Tag key={name} onRemove={() => {
                      const updated = config.poAuthorizedStaff.filter((n: string) => n !== name);
                      submit({ actionType: "savePoAuth", poViewStaff: JSON.stringify(config.poViewStaff), poAuthorizedStaff: JSON.stringify(updated), poRequireApproval: config.poRequireApproval ? "true" : "false", poAutoCreateOnLowStock: config.poAutoCreateOnLowStock ? "true" : "false" }, { method: "post" });
                    }}>{name}</Tag>
                  ))}
                </InlineStack>
                <Select label="Add staff to PO creation access" options={[{ label: "Select...", value: "" }, ...staffMembers.map((s: any) => ({ label: s.name, value: s.name }))]} value="" onChange={(v) => {
                  if (v && !config.poAuthorizedStaff.includes(v)) {
                    const updated = [...config.poAuthorizedStaff, v];
                    submit({ actionType: "savePoAuth", poViewStaff: JSON.stringify(config.poViewStaff), poAuthorizedStaff: JSON.stringify(updated), poRequireApproval: config.poRequireApproval ? "true" : "false", poAutoCreateOnLowStock: config.poAutoCreateOnLowStock ? "true" : "false" }, { method: "post" });
                  }
                }} />

                <Divider />
                <Checkbox label="Auto-create draft POs when low stock alerts fire" checked={config.poAutoCreateOnLowStock} onChange={(v) => {
                  submit({ actionType: "savePoAuth", poViewStaff: JSON.stringify(config.poViewStaff), poAuthorizedStaff: JSON.stringify(config.poAuthorizedStaff), poRequireApproval: config.poRequireApproval ? "true" : "false", poAutoCreateOnLowStock: v ? "true" : "false" }, { method: "post" });
                }} />

                <Divider />
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">📧 PO Notification Emails</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Notify these people when a draft PO is auto-created (from low stock alerts or demand forecasting). Add the owner and any managers who should review and approve POs.
                  </Text>
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <div style={{ flexGrow: 1 }}>
                      <TextField
                        label="Email Address"
                        labelHidden
                        value={poAlertEmailInput}
                        onChange={setPoAlertEmailInput}
                        autoComplete="email"
                        placeholder="owner@store.com, manager@store.com"
                      />
                    </div>
                    <Button onClick={() => {
                      if (poAlertEmailInput.trim()) {
                        submit({ actionType: "addPoAlertEmail", email: poAlertEmailInput }, { method: "post" });
                        setPoAlertEmailInput("");
                      }
                    }} disabled={!poAlertEmailInput.trim()}>Add</Button>
                  </InlineStack>
                  {poAlertEmailList.length > 0 && (
                    <InlineStack gap="200">
                      {poAlertEmailList.map((email: string) => (
                        <Tag key={email} onRemove={() => submit({ actionType: "removePoAlertEmail", email }, { method: "post" })}>
                          {email}
                        </Tag>
                      ))}
                    </InlineStack>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {/* API Key Management */}
          <Layout.AnnotatedSection
            title="🔑 API Keys"
            description="Generate API keys for external integrations (ERP, dashboards, automation)."
          >
            <Card>
              <BlockStack gap="400">
                <Banner tone="info">
                  <p>API keys enable external systems to access your inventory data. Keys are shown once on creation — save them securely.</p>
                </Banner>

                {apiKeys && apiKeys.length > 0 && (
                  <BlockStack gap="200">
                    {apiKeys.map((k: any) => (
                      <InlineStack key={k.id} align="space-between" blockAlign="center">
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="bold">{k.name}</Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {k.key} · Scope: {k.scope} · {k.isActive ? '✅ Active' : '❌ Revoked'}
                            {k.lastUsedAt ? ` · Last used: ${new Date(k.lastUsedAt).toLocaleDateString()}` : ''}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200">
                          {k.isActive && (
                            <Button size="slim" tone="critical" onClick={() => {
                              submit({ actionType: "revokeApiKey", keyId: k.id }, { method: "post" });
                            }}>Revoke</Button>
                          )}
                          <Button size="slim" onClick={() => {
                            submit({ actionType: "deleteApiKey", keyId: k.id }, { method: "post" });
                          }}>Delete</Button>
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}

                <Divider />
                <Text as="h3" variant="headingSm">Generate New API Key</Text>
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    <TextField label="Key Name" value="" onChange={() => {}} autoComplete="off" placeholder="e.g. QuickBooks Integration" id="apiKeyName" />
                  </div>
                  <div style={{ width: '120px' }}>
                    <Select label="Scope" options={[
                      { label: "Read", value: "read" },
                      { label: "Write", value: "write" },
                      { label: "Admin", value: "admin" }
                    ]} value="read" onChange={() => {}} id="apiKeyScope" />
                  </div>
                  <div style={{ paddingTop: '24px' }}>
                    <Button variant="primary" onClick={() => {
                      const nameEl = document.getElementById('apiKeyName') as HTMLInputElement;
                      const scopeEl = document.getElementById('apiKeyScope') as HTMLSelectElement;
                      const name = nameEl?.value || '';
                      const scope = scopeEl?.value || 'read';
                      if (!name) return;
                      submit({ actionType: "createApiKey", keyName: name, keyScope: scope }, { method: "post" });
                    }}>Generate Key</Button>
                  </div>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}
