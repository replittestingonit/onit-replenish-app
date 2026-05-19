import { json, type ActionFunctionArgs, type LoaderFunctionArgs, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, TextField, Select, Button, Banner, FormLayout, Checkbox, DropZone, Thumbnail, InlineStack, Combobox, Listbox, Icon, Box, Modal } from "@shopify/polaris";
import { NoteIcon, SearchIcon } from "@shopify/polaris-icons";
import { useState, useMemo, useCallback, useEffect } from "react";
import prisma from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";
import fs from "fs";
import path from "path";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY || "re_12345");

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Use the offline admin client because workers may have their Shopify inventory permissions stripped
  const { admin } = await unauthenticated.admin(shop);

  const config = await prisma.appConfiguration.findUnique({ where: { shop } });
  const strictEnabled = !!config?.strictInventory;

  // Auto-detect the current logged-in user from the Shopify session
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
    const allowedLocIds = constraints[currentUser];
    locations = locations.filter((loc: any) => allowedLocIds.includes(loc.id));
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

  return json({ 
    strictEnabled, 
    locations, 
    variants,
    config: {
      requireReason: true,
      requireDetailedReason: config?.requireDetailedReason || false,
      requireInboundReference: config?.requireInboundReference || false,
      adjustmentReasons: JSON.parse(config?.adjustmentReasons || "[]"),
      evidenceStorage: config?.evidenceStorage || "email",
      googleDriveEnabled: config?.googleDriveEnabled || false,
      serialNumberRequiredItems: JSON.parse(config?.serialNumberRequiredItems || "[]"),
    },
    currentUser
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Use the offline admin client because workers may have their Shopify inventory permissions stripped
  const { admin } = await unauthenticated.admin(shop);

  const formData = await request.formData();

  const inventoryItemId = formData.get("inventoryItemId") as string;
  const locationId = formData.get("locationId") as string;
  const deltaStr = formData.get("delta") as string;
  const staffName = formData.get("staffName") as string;
  const reasonDropdown = formData.get("reason") as string;
  const detailedReason = formData.get("detailedReason") as string;
  const reason = detailedReason ? `${reasonDropdown} - ${detailedReason}` : reasonDropdown;
  const isFullyMetStr = formData.get("isFullyMet") as string;
  const resourceUrlsStr = formData.get("resourceUrls") as string;
  const exceptionNote = formData.get("exceptionNote") as string;

  // Inbound reference fields — at least one ref required, plus supplier
  const poNumber = formData.get("poNumber") as string || "";
  const invoiceNumber = formData.get("invoiceNumber") as string || "";
  const packingSlipNumber = formData.get("packingSlipNumber") as string || "";
  const supplierName = formData.get("supplierName") as string || "";

  // Consolidate into a single referenceNumber for storage/downstream
  const serialNumbersText = formData.get("serialNumbersText") as string;
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
  if (isNaN(delta) || delta === 0) {
    return json({ error: "Invalid quantity" }, { status: 400 });
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

  // Evaluate Unauthorized Return Rule
  if (reasonDropdown === "Customer Return" || reasonDropdown === "Return") {
    const returnRule = activeRules.find(r => r.triggerType === "unauthorized_return");
    if (returnRule && returnRule.haltFulfillment && config?.planType === 'premium') {
      // Check if they provided an RMA or Order ID
      const hasOrderId = detailedReason && (detailedReason.includes("#") || detailedReason.toLowerCase().includes("rma") || detailedReason.toLowerCase().includes("order"));
      
      if (!hasOrderId && !isOverrideValid) {
        // Alert but BLOCK transaction until manager override
        await prisma.triggeredAlert.create({
          data: {
            shop,
            ruleId: returnRule.id,
            person: staffName,
            productName: `Location: ${locationId}`,
            details: `Staff attempted to process an unauthorized return without an Order ID/RMA.`,
            status: "active"
          }
        });
        return json({ error: "MANAGER_OVERRIDE_REQUIRED", message: "Unauthorized Return Detected: A valid Order ID/RMA is required to receive this item. Please call a manager to override." }, { status: 403 });
      } else if (isOverrideValid) {
        // Log the override
        await prisma.triggeredAlert.create({
          data: {
            shop,
            ruleId: returnRule.id,
            person: overriderName,
            productName: `Location: ${locationId}`,
            details: `Manager manually overrode an unauthorized return attempt by ${staffName}.`,
            status: "silenced"
          }
        });
      }
    }
  }
  // --- High Value "Sacred" Item Check ---
  const highValueItems = JSON.parse(config?.highValueItems || "[]");
  if (highValueItems.includes(inventoryItemId)) {
    let sacredRule = await prisma.securityRule.findFirst({
      where: { shop, triggerType: 'sacred_item' }
    });
    
    if (!sacredRule) {
      sacredRule = await prisma.securityRule.create({
        data: {
          shop,
          name: "Protected Item Alert",
          description: "Fires when staff attempts to adjust a highly valuable, protected item.",
          triggerType: "sacred_item",
          isActive: true
        }
      });
    }

    const alertRecord = await prisma.triggeredAlert.create({
      data: {
        shop,
        ruleId: sacredRule.id,
        person: staffName,
        productName: `Item ID: ${inventoryItemId}`,
        details: `Attempted to change protected inventory item by ${delta}. Reason given: ${reason}`,
        status: 'active',
      }
    });

    if (config?.emailAlertsEnabled && config.alertEmailAddress) {
      fetch(`${new URL(request.url).origin}/api/send-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop,
          alertId: alertRecord.id,
          ruleName: sacredRule.name,
          person: staffName,
          details: `RESTRICTED ACTION BLOCKED: Attempted to change protected inventory item by ${delta}. Reason given: ${reason}`,
        })
      }).catch(e => console.error("Failed to trigger email alert", e));
    }

    return json({ error: "RESTRICTED: This is a high-value protected item. You cannot manually adjust this inventory. The store owner has been notified of this attempt. Please contact management immediately." }, { status: 403 });
  }
  // ----------------------------------------

  // --- ADVANCED ENTERPRISE FREEZES ---
  let freezeReason: string | null = null;
  let freezeRuleTriggerType: string | null = null;

  // 1. Magnitude Freeze
  if (config?.maxAdjustmentMagnitude !== null && Math.abs(delta) > config!.maxAdjustmentMagnitude) {
    freezeReason = `Adjustment of ${delta} exceeds the maximum allowed magnitude of ${config!.maxAdjustmentMagnitude}.`;
    freezeRuleTriggerType = 'magnitude_freeze';
  }

  // 2. Location Freeze
  const frozenLocations = JSON.parse(config?.frozenLocations || "[]");
  if (!freezeReason && frozenLocations.includes(locationId)) {
    freezeReason = `This location is in a Quarantine state. Manual inventory adjustments are strictly blocked.`;
    freezeRuleTriggerType = 'location_freeze';
  }

  // 3. Directional Freeze (Receive Only)
  const receiveOnlyStaff = JSON.parse(config?.receiveOnlyStaff || "[]");
  if (!freezeReason && delta < 0 && receiveOnlyStaff.includes(staffName)) {
    freezeReason = `Your profile is designated as "Receive Only". You are blocked from submitting negative inventory corrections or write-offs.`;
    freezeRuleTriggerType = 'directional_freeze';
  }

  // 4. Time-Based Hard Freeze
  if (!freezeReason && config?.hardFreezeOutsideHours && config?.businessStart && config?.businessEnd) {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
    const timeString = formatter.format(now);
    const timeParts = timeString.split(':');
    const nowHour = parseInt(timeParts[0], 10);
    const nowMinute = parseInt(timeParts[1], 10);
    const nowTime = nowHour + nowMinute / 60;

    const [startHour, startMinute] = config.businessStart.split(':').map(Number);
    const startTime = startHour + startMinute / 60;

    const [endHour, endMinute] = config.businessEnd.split(':').map(Number);
    const endTime = endHour + endMinute / 60;

    // Handle overnight shifts
    let isOutsideHours = false;
    if (startTime <= endTime) {
      isOutsideHours = nowTime < startTime || nowTime > endTime;
    } else {
      isOutsideHours = nowTime > endTime && nowTime < startTime;
    }

    if (isOutsideHours) {
      freezeReason = `Operating Hours Lock is enabled. Manual inventory adjustments are strictly blocked outside of normal business hours (${config.businessStart} - ${config.businessEnd}).`;
      freezeRuleTriggerType = 'time_freeze';
    }
  }

  if (freezeReason && freezeRuleTriggerType) {
    let rule = await prisma.securityRule.findFirst({
      where: { shop, triggerType: freezeRuleTriggerType }
    });
    
    if (!rule) {
      rule = await prisma.securityRule.create({
        data: {
          shop,
          name: "Enterprise Hard Freeze",
          description: "Fires when staff attempts an action that violates an enterprise freeze policy.",
          triggerType: freezeRuleTriggerType,
          isActive: true
        }
      });
    }

    const alertRecord = await prisma.triggeredAlert.create({
      data: {
        shop,
        ruleId: rule.id,
        person: staffName,
        productName: `Item ID: ${inventoryItemId}`,
        details: `BLOCKED BY POLICY: ${freezeReason} Attempted change: ${delta}. Reason given: ${reason}`,
        status: 'active',
      }
    });

    if (config?.emailAlertsEnabled && config.alertEmailAddress) {
      fetch(`${new URL(request.url).origin}/api/send-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop,
          alertId: alertRecord.id,
          ruleName: rule.name,
          person: staffName,
          details: `RESTRICTED ACTION BLOCKED: ${freezeReason} Attempted change: ${delta}. Reason given: ${reason}`,
        })
      }).catch(e => console.error("Failed to trigger email alert", e));
    }

    return json({ error: `RESTRICTED: ${freezeReason} The store owner has been notified of this attempt. Please contact management immediately.` }, { status: 403 });
  }
  // ----------------------------------------

  // 1. Finalize the Staged Uploads in Shopify
  let shopifyFileIds: string[] = [];
  if (resourceUrlsStr) {
    try {
      const resourceUrls = JSON.parse(resourceUrlsStr);
      if (resourceUrls.length > 0) {
        const fileInputs = resourceUrls.map((url: string) => ({
          alt: "Inbound Evidence",
          contentType: "FILE", // FILE works for both images and videos
          originalSource: url
        }));

        const fileCreateRes = await admin.graphql(`
          mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
              files { id fileStatus }
              userErrors { field message }
            }
          }
        `, {
          variables: { files: fileInputs }
        });

        const fileData = await fileCreateRes.json();
        const createdFiles = fileData.data?.fileCreate?.files || [];
        shopifyFileIds = createdFiles.map((f: any) => f.id);
      }
    } catch (e) {
      console.error("Failed to parse resource urls or run fileCreate", e);
    }
  }

  // Store the Shopify IDs or the Exception Note
  let finalProofReference = null;
  if (shopifyFileIds.length > 0) {
    finalProofReference = JSON.stringify(shopifyFileIds);
  } else if (exceptionNote) {
    finalProofReference = `Exception: ${exceptionNote}`;
  }

  // Adjust inventory via GraphQL
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
          changes: [{
            delta: delta,
            inventoryItemId: inventoryItemId,
            locationId: locationId
          }]
        }
      }
    });

    adjustData = await adjustRes.json();
    const errors = adjustData.data?.inventoryAdjustQuantities?.userErrors;
    if (errors && errors.length > 0) {
      return json({ error: errors[0].message }, { status: 400 });
    }
  } catch (error: any) {
    console.error("GraphQL Adjust Error:", JSON.stringify(error, null, 2));
    if (error.graphQLErrors) {
      console.error("GraphQL Adjust Error Detail:", JSON.stringify(error.graphQLErrors, null, 2));
    }
    return json({ error: "Failed to adjust inventory due to a GraphQL API error. Check server logs." }, { status: 500 });
  }

  // Capture the Shopify transaction reference
  const adjustmentGroupId = adjustData.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup?.id || null;

  // Wait a moment for the webhook to fire, then stitch our exact staff name to it!
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Find the exact event that just fired
  const recentEvent = await prisma.inventoryEvent.findFirst({
    where: {
      shop,
      inventoryItemId,
      time: { gte: new Date(Date.now() - 30000) },
      reason: { startsWith: 'Location: ' } // Find the raw one created by the webhook
    },
    orderBy: { time: 'desc' }
  });

  if (recentEvent) {
    let finalReason = `Manual Correction via App - ${staffName}`;
    if (reason) finalReason += ` (${reason})`;

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
    // If webhook failed or is slow, insert it manually
    await prisma.inventoryEvent.create({
      data: {
        shop,
        inventoryItemId,
        time: new Date(),
        available: 0,
        reason: `Manual Correction via App - ${staffName} ${reason ? `(${reason})` : ''}`,
        referenceNumber: referenceNumber || null,
        isFullyMet: isFullyMetStr === 'true',
        proofImage: finalProofReference,
        shopifyAdjustmentGroupId: adjustmentGroupId
      }
    });
  }
  
  // Handle Reason-Based Alerts
  const alertReasons = JSON.parse(config?.alertOnReasons || "[]");
  if (alertReasons.includes(reasonDropdown)) {
    let reasonRule = await prisma.securityRule.findFirst({
      where: { shop, triggerType: 'flagged_reason' }
    });
    
    if (!reasonRule) {
      reasonRule = await prisma.securityRule.create({
        data: {
          shop,
          name: 'Flagged Reason Alert',
          description: 'Fires when an inventory adjustment uses a reason flagged by the owner.',
          triggerType: 'flagged_reason',
          isActive: true
        }
      });
    }

    const alertRecord = await prisma.triggeredAlert.create({
      data: {
        shop,
        ruleId: reasonRule.id,
        person: staffName,
        productName: `Item ID: ${inventoryItemId}`,
        details: `Reason: ${reason}`, // Contains both the category and the written explanation
        status: 'active',
        transactionId: finalProofReference || adjustmentGroupId?.replace('gid://shopify/InventoryAdjustmentGroup/', '#')
      }
    });

    if (config?.emailAlertsEnabled && config?.alertEmailAddress) {
      const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
      let evidenceHtml = "";
      const txnRef = adjustmentGroupId ? adjustmentGroupId.replace('gid://shopify/InventoryAdjustmentGroup/', '#') : '';
      if (config.privateEvidenceMode) {
        evidenceHtml = `
          <hr/>
          <p>📎 <strong>Evidence captured and secured.</strong></p>
          <p>Photos and documents for this alert are available in your app dashboard.</p>
          <p><a href="https://${shop}/admin/apps/inventory-protection/app/alert/${alertRecord.id}">
            <strong>→ View Evidence for Alert ${alertRecord.id.slice(-8).toUpperCase()}</strong>
          </a></p>
          ${txnRef ? `<p><strong>Shopify Transaction:</strong> ${txnRef}</p>` : ''}
        `;
      } else if (resourceUrls.length > 0) {
        evidenceHtml = `
          <hr/>
          <p>📎 <strong>Attached Evidence:</strong></p>
          <ul>${resourceUrls.map(url => `<li><a href="${url}">${url}</a></li>`).join('')}</ul>
          ${txnRef ? `<p><strong>Shopify Transaction:</strong> ${txnRef}</p>` : ''}
        `;
      }
      for (const email of emailList) {
        try {
          await resend.emails.send({
            from: "ONIT Security <alerts@onitnetworking.com>",
            to: email,
            subject: `[ALERT] Flagged Reason: ${reasonDropdown}`,
            html: `
              <h2>Flagged Adjustment Reason</h2>
              <p>An inventory adjustment was made using a reason you have flagged for alerts.</p>
              <p><strong>Staff Name:</strong> ${staffName}</p>
              <p><strong>Product ID:</strong> ${inventoryItemId}</p>
              <p><strong>Location ID:</strong> ${locationId}</p>
              <p><strong>Quantity Change:</strong> ${delta > 0 ? '+' : ''}${delta} units</p>
              <p><strong>Full Reason:</strong> ${reason}</p>
              ${evidenceHtml}
            `
          });
        } catch (err) {
          console.error("Failed to send email alert", err);
        }
      }
    }
  }

  // Handle Supplier Mismatch Alert
  if (delta > 0 && referenceNumber && isFullyMetStr === 'false') {
    let mismatchRule = await prisma.securityRule.findFirst({
      where: { shop, triggerType: 'supplier_mismatch' }
    });
    
    if (!mismatchRule) {
      mismatchRule = await prisma.securityRule.create({
        data: {
          shop,
          name: 'Supplier Mismatch',
          description: 'Fires when receiving staff logs a physical discrepancy against a packing slip.',
          triggerType: 'supplier_mismatch',
          isActive: true
        }
      });
    }

    const alertRecord = await prisma.triggeredAlert.create({
      data: {
        shop,
        ruleId: mismatchRule.id,
        person: staffName,
        productName: `Item ID: ${inventoryItemId}`,
        details: `Short-shipment reported against inbound reference ${referenceNumber}.`,
        status: 'active',
        transactionId: finalProofReference
      }
    });

    if (config?.emailAlertsEnabled && config?.alertEmailAddress) {
      const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
      
      // Build the evidence section based on privacy mode
      let evidenceHtml = "";
      const txnRef = adjustmentGroupId ? adjustmentGroupId.replace('gid://shopify/InventoryAdjustmentGroup/', '#') : '';

      if (config.privateEvidenceMode) {
        // PRIVATE MODE — no file links in the email, point to in-app evidence viewer
        evidenceHtml = `
          <hr/>
          <p>📎 <strong>Evidence captured and secured.</strong></p>
          <p>Photos, packing slips, and documents for this alert are available in your app dashboard.</p>
          <p><a href="https://${shop}/admin/apps/inventory-protection/app/alert/${alertRecord.id}">
            <strong>→ View Evidence for Alert ${alertRecord.id.slice(-8).toUpperCase()}</strong>
          </a></p>
          ${txnRef ? `<p><strong>Shopify Transaction:</strong> ${txnRef}</p>` : ''}
          <p><em>Evidence files are not attached to this email for your security.</em></p>
        `;
      } else if (config.evidenceStorage === "google_drive" && finalProofReference) {
        // GOOGLE DRIVE MODE (ONIT Vision key holders)
        evidenceHtml = `
          <hr/>
          <p>📎 <strong>Evidence (Private Google Drive):</strong></p>
          <p>Files have been uploaded to your private Google Drive folder.</p>
          ${txnRef ? `<p><strong>Shopify Transaction:</strong> ${txnRef}</p>` : ''}
          <p><em>These files are only accessible to your Google account.</em></p>
        `;
        try {
          const links = JSON.parse(finalProofReference);
          if (Array.isArray(links) && links.length > 0 && links[0].startsWith('https://drive.google.com')) {
            evidenceHtml = `
              <hr/>
              <p>📎 <strong>Evidence (Private Google Drive):</strong></p>
              <ul>${links.map((link: string, i: number) => `<li><a href="${link}">View Evidence File ${i + 1}</a></li>`).join('')}</ul>
              ${txnRef ? `<p><strong>Shopify Transaction:</strong> ${txnRef}</p>` : ''}
              <p><em>These links are only accessible to your Google account.</em></p>
            `;
          }
        } catch (e) { /* Not Drive links */ }
      } else if (finalProofReference) {
        // STANDARD MODE — include direct file reference
        evidenceHtml = `
          <hr/>
          <p><strong>Photo Evidence:</strong> <a href="${finalProofReference}">View Packing Slip</a></p>
          ${txnRef ? `<p><strong>Shopify Transaction:</strong> ${txnRef}</p>` : ''}
        `;
      } else {
        evidenceHtml = txnRef ? `<hr/><p><strong>Shopify Transaction:</strong> ${txnRef}</p>` : '';
      }

      try {
        await resend.emails.send({
          from: "Security Alerts <onboarding@resend.dev>",
          to: emailList,
          subject: "🚨 SECURITY ALERT: Supplier Mismatch",
          html: `
            <h2>Supplier Mismatch Detected</h2>
            <p><strong>Store:</strong> ${shop}</p>
            <p><strong>Rule Triggered:</strong> Supplier Mismatch</p>
            <p><strong>Date & Time:</strong> ${new Date().toLocaleString()}</p>
            <p><strong>Staff Name:</strong> ${staffName}</p>
            <p><strong>Product ID:</strong> ${inventoryItemId}</p>
            <p><strong>Location ID:</strong> ${locationId}</p>
            <p><strong>Quantity Change:</strong> +${delta} units</p>
            <p><strong>Adjustment Reason:</strong> ${reason || "N/A"}</p>
            <p><strong>The Mismatch:</strong> Short-shipment reported against inbound reference ${referenceNumber}.</p>
            ${evidenceHtml}
          `
        });
      } catch (err) {
        console.error("Failed to send email alert", err);
      }
    }
  }

  // Check for Manual Correction Spike
  let manualRule = await prisma.securityRule.findFirst({
    where: { shop, triggerType: 'manual_correction', isActive: true }
  });
  if (manualRule) {
    const threshold = parseInt(manualRule.quantityThreshold || "3", 10);
    if (Math.abs(delta) >= threshold) {
      await prisma.triggeredAlert.create({
        data: {
          shop,
          ruleId: manualRule.id,
          person: staffName,
          productName: `Item ID: ${inventoryItemId}`,
          details: `Manual correction of ${delta > 0 ? '+' : ''}${delta} units, meeting or exceeding the threshold of ${threshold}.`,
          status: 'active',
          transactionId: finalProofReference || adjustmentGroupId?.replace('gid://shopify/InventoryAdjustmentGroup/', '#')
        }
      });
    }
  }

  return json({ success: true });
};

export default function AdjustInventory() {
  const { strictEnabled, locations, variants, config, currentUser } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const nav = useNavigation();

  useEffect(() => {
    if (actionData?.success) {
      if (typeof shopify !== 'undefined' && shopify?.toast) {
        shopify.toast.show("Inventory Change has been Made!", { duration: 750 });
      }
      setInventoryItemId("");
      setProductInputValue("");
      setLocationId("");
      setDelta("");
      setReason("");
      setDetailedReason("");
      setPoNumber("");
      setInvoiceNumber("");
      setPackingSlipNumber("");
      setSupplierName("");
      setIsFullyMet(false);
      setProofFiles([]);
      setExceptionNote("");
      setProofVerified(false);
    } else if (actionData?.error) {
      if (actionData.error === "MANAGER_OVERRIDE_REQUIRED") {
        setShowManagerModal(true);
        if (typeof shopify !== 'undefined' && shopify?.toast) {
          shopify.toast.show("Manager Override Required", { isError: true });
        }
      } else {
        if (typeof shopify !== 'undefined' && shopify?.toast) {
          shopify.toast.show(actionData.error, { isError: true });
        }
      }
    }
  }, [actionData]);

  const [showManagerModal, setShowManagerModal] = useState(false);
  const [managerOverridePin, setManagerOverridePin] = useState("");

  const [inventoryItemId, setInventoryItemId] = useState("");
  const [productInputValue, setProductInputValue] = useState("");
  const [productOptions, setProductOptions] = useState(variants || []);
  const [locationId, setLocationId] = useState("");

  useEffect(() => {
    const savedLocation = window.localStorage.getItem('preferredAdjustmentLocationId');
    if (savedLocation && !locationId) {
      const valid = locations?.find((l: any) => l.id === savedLocation);
      if (valid) setLocationId(savedLocation);
    }
  }, [locations]);

  const handleLocationChange = useCallback((val: string) => {
    setLocationId(val);
    window.localStorage.setItem('preferredAdjustmentLocationId', val);
  }, []);

  const [delta, setDelta] = useState("");
  const [staffName, setStaffName] = useState(currentUser || "Shopify User");
  const [reason, setReason] = useState("");
  const [detailedReason, setDetailedReason] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [packingSlipNumber, setPackingSlipNumber] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [isFullyMet, setIsFullyMet] = useState(false);
  const [proofFiles, setProofFiles] = useState<{file: File, url: string, isUploading: boolean, resourceUrl?: string}[]>([]);
  const [exceptionNote, setExceptionNote] = useState("");
  const [proofVerified, setProofVerified] = useState(false);
  const [serialNumbersText, setSerialNumbersText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const handleBarcodeScan = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("adjust-scan-region");
      const decodedText = await scanner.scanFile(file, true);
      const found = variants.find((v: any) => v.sku === decodedText || v.label.includes(decodedText) || v.value.includes(decodedText));
      if (found) {
        setInventoryItemId(found.value);
        setProductInputValue(found.label);
        if (typeof shopify !== 'undefined' && shopify?.toast) {
          shopify.toast.show("Product scanned successfully!");
        }
      } else {
        if (typeof shopify !== 'undefined' && shopify?.toast) {
          shopify.toast.show(`Barcode ${decodedText} not found`, { isError: true });
        }
      }
      await scanner.clear();
    } catch (err: any) {
      if (typeof shopify !== 'undefined' && shopify?.toast) {
        shopify.toast.show("Could not read barcode. Try a clearer photo.", { isError: true });
      }
    }
    e.target.value = '';
  }, [variants]);

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
          setFileError("Image must be smaller than 20 MB.");
          return false;
        }
        return true;
      }).map(f => ({ file: f, url: URL.createObjectURL(f), isUploading: true }));

      if (newFiles.length === 0) return;

      setProofFiles(prev => [...prev, ...newFiles]);
      setProofVerified(false);

      const useGoogleDrive = config.evidenceStorage === 'google_drive' && config.googleDriveEnabled;

      for (const item of newFiles) {
        try {
          if (useGoogleDrive) {
            // ===== GOOGLE DRIVE UPLOAD PATH =====
            const driveFormData = new FormData();
            driveFormData.append("file", item.file);
            driveFormData.append("staffName", staffName || "Unknown");
            driveFormData.append("referenceNumber", [poNumber, invoiceNumber, packingSlipNumber].filter(Boolean).join('/') || "");

            const res = await window.shopify.fetch("/api/google-drive-upload", {
              method: "POST",
              body: driveFormData
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || "Drive upload failed");

            // Store the Drive view link as the resourceUrl
            setProofFiles(prev => prev.map(p => 
              p.file.name === item.file.name 
                ? { ...p, isUploading: false, resourceUrl: data.viewLink } 
                : p
            ));
          } else {
            // ===== SHOPIFY STAGED UPLOAD PATH (default) =====
            const res = await window.shopify.fetch("/api/staged-upload", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filename: item.file.name, mimeType: item.file.type, fileSize: item.file.size })
            });
            const data = await res.json();
            if (!data.target) throw new Error(data.error || "Failed to get upload target");

            const formData = new FormData();
            data.target.parameters.forEach((p: any) => formData.append(p.name, p.value));
            formData.append("file", item.file);

            const uploadRes = await fetch(data.target.url, { method: "POST", body: formData });
            if (!uploadRes.ok) throw new Error("Direct upload failed");

            setProofFiles(prev => prev.map(p => 
              p.file.name === item.file.name 
                ? { ...p, isUploading: false, resourceUrl: data.target.resourceUrl } 
                : p
            ));
          }
        } catch (e: any) {
          console.error(e);
          setFileError(`Failed to upload ${item.file.name}: ${e.message}`);
          setProofFiles(prev => prev.filter(p => p.file.name !== item.file.name));
        }
      }
    },
    [proofFiles, config.evidenceStorage, config.googleDriveEnabled, staffName, poNumber, invoiceNumber, packingSlipNumber]
  );

  const locOptions = useMemo(() => {
    if (!locations) return [];
    const opts = locations.map((l: any) => ({ label: l.name, value: l.id }));
    opts.unshift({ label: "Select a location...", value: "" });
    return opts;
  }, [locations]);

  const updateProductText = useCallback(
    (value: string) => {
      setProductInputValue(value);

      if (value === '') {
        setProductOptions(variants);
        return;
      }

      const filterRegex = new RegExp(value, 'i');
      const resultOptions = variants.filter(
        (option: any) => option.label.match(filterRegex) || option.sku.match(filterRegex)
      );
      setProductOptions(resultOptions);
    },
    [variants]
  );

  const updateProductSelection = useCallback(
    (selected: string) => {
      const selectedValue = selected;
      const matchedOption = variants.find((option: any) => {
        return option.value.match(selectedValue);
      });

      setInventoryItemId(selectedValue);
      setProductInputValue(matchedOption ? matchedOption.label : '');
    },
    [variants]
  );


  const reasonOptions = useMemo(() => {
    if (!config) return [];
    
    const numDelta = parseInt(delta, 10);
    const isRemoving = !isNaN(numDelta) && numDelta < 0;
    const isAdding = !isNaN(numDelta) && numDelta > 0;

    const filteredReasons = config.adjustmentReasons.filter((r: string) => {
      // Hide incoming-only reasons if we are REMOVING inventory
      if (isRemoving && (r === "New Inventory Received" || r === "Customer Return")) {
        return false;
      }
      
      // Hide outgoing-only reasons if we are ADDING inventory
      if (isAdding && (r === "Damaged Item" || r === "Stolen" || r.toLowerCase().includes("return to shipper") || r.toLowerCase().includes("return to supplier"))) {
        return false;
      }

      return true;
    });

    const opts = filteredReasons.map((r: string) => ({ label: r, value: r }));
    opts.unshift({ label: "Select a reason...", value: "" });
    return opts;
  }, [config, delta]);

  // Reset reason if it becomes invalid due to delta change
  useEffect(() => {
    if (reason && !reasonOptions.some(opt => opt.value === reason)) {
      setReason("");
    }
  }, [reasonOptions, reason]);

  if (!strictEnabled) {
    return (
      <Page title="Change">
        <Layout>
          <Layout.Section>
            <Banner 
              title="WARNING: Inventory is currently unlocked." 
              tone="warning"
              action={{ content: 'Click here to change this', url: '/app/settings' }}
            >
              <p>You have been granted inventory admin access directly in the Shopify Products page. To require worker names, you must turn it on.</p>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }
  const isSubmitting = nav.state === "submitting";
  const numDelta = parseInt(delta, 10);
  const isAdding = !isNaN(numDelta) && numDelta > 0;
  
  // Determine if Inbound Tracking should be shown
  const showInboundTracking = isAdding && reason === "New Inventory Received";

  const hasAnyReference = !!(poNumber || invoiceNumber || packingSlipNumber);

  // Serial Number Validation
  const requiresSerial = config.serialNumberRequiredItems?.includes(inventoryItemId);
  const parsedDelta = parseInt(delta, 10);
  
  // Detailed reason validation (at least 3 words)
  const isDetailedReasonValid = config.requireDetailedReason 
    ? detailedReason.trim().split(/\s+/).length >= 3 
    : true;

  const hasReasons = config.adjustmentReasons.length > 0;
  let isValid = !!(staffName && inventoryItemId && locationId && delta && (hasReasons ? reason : true) && isDetailedReasonValid);
  
  if (requiresSerial && !isNaN(parsedDelta) && parsedDelta !== 0) {
    const requiredCount = Math.abs(parsedDelta);
    const serials = serialNumbersText.split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 0);
    if (serials.length !== requiredCount) isValid = false;
  }
  
  if (showInboundTracking && config.requireInboundReference) {
    // At least one reference number AND the supplier name are required
    if (!hasAnyReference) isValid = false;
    if (!supplierName) isValid = false;
    // We require either verified files OR an exception note
    if (proofFiles.length > 0 && !proofVerified) isValid = false;
    if (proofFiles.length === 0 && exceptionNote.length < 5) isValid = false;
  }

  const handleSubmit = () => {
    const serials = serialNumbersText.split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 0).join(', ');

    const formData = new FormData();
    formData.append("inventoryItemId", inventoryItemId);
    formData.append("locationId", locationId);
    if (requiresSerial) formData.append("serialNumbersText", serials);
    formData.append("delta", delta);
    formData.append("staffName", staffName);
    formData.append("reason", reason);
    if (detailedReason) {
      formData.append("detailedReason", detailedReason);
    }
    if (managerOverridePin) {
      formData.append("managerOverridePin", managerOverridePin);
    }
    if (showInboundTracking) {
      formData.append("poNumber", poNumber);
      formData.append("invoiceNumber", invoiceNumber);
      formData.append("packingSlipNumber", packingSlipNumber);
      formData.append("supplierName", supplierName);
      formData.append("isFullyMet", isFullyMet.toString());
      
      const resourceUrls = proofFiles.map(p => p.resourceUrl).filter(Boolean);
      if (resourceUrls.length > 0) {
        formData.append("resourceUrls", JSON.stringify(resourceUrls));
      }
      if (exceptionNote) {
        formData.append("exceptionNote", exceptionNote);
      }
    }
    submit(formData, { method: "post" });

    // Reset form
    setDelta("");
    setReason("");
    setDetailedReason("");
    setPoNumber("");
    setInvoiceNumber("");
    setPackingSlipNumber("");
    setSupplierName("");
    setIsFullyMet(false);
    setProofFiles([]);
    setExceptionNote("");
    setProofVerified(false);
  };

  return (
    <Page title="Change (Secure)" subtitle="All changes made here are securely logged with your exact name.">
      <Layout>
        <Layout.Section>
          {actionData?.error && (
            <Box paddingBlockEnd="400">
              <Banner tone="critical" title="Security Block">
                <p>{actionData.error}</p>
              </Banner>
            </Box>
          )}
          <Card padding="400">
            <FormLayout>
              
              {/* Auto-detected staff name */}
              <Banner tone="info">
                <p>Submitting as: <Text as="span" fontWeight="bold" variant="bodyMd">{staffName}</Text></p>
              </Banner>
              
              <InlineStack blockAlign="end" gap="400">
                <div style={{ flexGrow: 1 }}>
                  <Combobox
                    activator={
                      <Combobox.TextField
                        prefix={<Icon source={SearchIcon} />}
                        onChange={updateProductText}
                        label="Product"
                        value={productInputValue}
                        placeholder="Search by product name or SKU"
                        autoComplete="off"
                      />
                    }
                  >
                    {productOptions.length > 0 ? (
                      <Listbox onSelect={updateProductSelection}>
                        {productOptions.map((option: any) => (
                          <Listbox.Option
                            key={option.value}
                            value={option.value}
                            selected={inventoryItemId === option.value}
                            accessibilityLabel={option.label}
                          >
                            {option.label}
                          </Listbox.Option>
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

              <div id="adjust-scan-region" style={{ display: 'none' }}></div>
              
              <Select
                label="Location"
                options={locOptions}
                value={locationId}
                onChange={handleLocationChange}
              />

              <TextField
                label="Quantity Adjustment (Delta)"
                type="number"
                value={delta}
                onChange={setDelta}
                helpText="Use positive numbers to add stock, negative to remove (e.g., -1)."
                autoComplete="off"
                requiredIndicator
              />

              {requiresSerial && !isNaN(parsedDelta) && parsedDelta !== 0 && (
                <Card background="bg-surface-warning">
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingMd">Serial Numbers Required</Text>
                    <Text as="p" variant="bodySm">
                      This item requires exact serial number tracking. Please scan or enter exactly {Math.abs(parsedDelta)} serial numbers (one per line or comma-separated).
                    </Text>
                    <TextField
                      label={`Serial Numbers (${serialNumbersText.split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 0).length} / ${Math.abs(parsedDelta)})`}
                      value={serialNumbersText}
                      onChange={setSerialNumbersText}
                      multiline={4}
                      autoComplete="off"
                      requiredIndicator
                    />
                  </BlockStack>
                </Card>
              )}

              {config.adjustmentReasons.length > 0 && (
                <BlockStack gap="400">
                  <Select
                    label="Reason for Adjustment (Required)"
                    options={reasonOptions}
                    value={reason}
                    onChange={setReason}
                    requiredIndicator
                  />
                  {config.requireDetailedReason && (
                    <TextField
                      label="Detailed Explanation (Required)"
                      value={detailedReason}
                      onChange={setDetailedReason}
                      autoComplete="off"
                      multiline={3}
                      helpText="Please explain why this inventory is being adjusted (minimum 3 words)."
                      requiredIndicator
                    />
                  )}
                </BlockStack>
              )}

              {showInboundTracking && (
                <Card background="bg-surface-secondary">
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingMd">Inbound Tracking</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Enter at least one reference number below, plus the supplier name.{config.requireInboundReference ? '' : ' (Optional)'}
                    </Text>

                    <TextField
                      label="From (Manufacturer / Supplier)"
                      value={supplierName}
                      onChange={setSupplierName}
                      autoComplete="off"
                      placeholder="e.g. Acme Manufacturing"
                      requiredIndicator={config.requireInboundReference}
                    />

                    <FormLayout.Group>
                      <TextField
                        label="PO Number"
                        value={poNumber}
                        onChange={setPoNumber}
                        autoComplete="off"
                        placeholder="e.g. PO-2026-0458"
                      />
                      <TextField
                        label="Invoice Number"
                        value={invoiceNumber}
                        onChange={setInvoiceNumber}
                        autoComplete="off"
                        placeholder="e.g. INV-12345"
                      />
                      <TextField
                        label="Packing Slip Number"
                        value={packingSlipNumber}
                        onChange={setPackingSlipNumber}
                        autoComplete="off"
                        placeholder="e.g. PS-98765"
                      />
                    </FormLayout.Group>

                    {config.requireInboundReference && !hasAnyReference && (poNumber !== '' || invoiceNumber !== '' || packingSlipNumber !== '' || supplierName !== '') && (
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
                      {config.evidenceStorage === 'google_drive' && config.googleDriveEnabled
                        ? '🔒 Uploading to your private Google Drive folder. Files are not attached to emails.'
                        : 'Videos upload directly to Shopify (Max 1 GB). Images max 20 MB.'
                      }
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
                              {pf.isUploading ? "Uploading to Shopify..." : "Ready"}
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
                        helpText="If you cannot upload a video or photo right now, explain why. This will save the transaction as a Draft."
                      />
                    )}
                  </BlockStack>
                </Card>
              )}



              <Button 
                variant="primary" 
                onClick={handleSubmit} 
                disabled={!isValid || isSubmitting}
                loading={isSubmitting}
              >
                Submit Adjustment
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
