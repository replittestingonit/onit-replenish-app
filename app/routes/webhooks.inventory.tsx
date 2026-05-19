import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY || "re_12345");

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "INVENTORY_LEVELS_UPDATE") {
    return new Response("Unhandled webhook topic", { status: 404 });
  }

  // Fetch active rules for this shop
  const activeRules = await prisma.securityRule.findMany({
    where: { shop, isActive: true }
  });

  let locationName = "Unknown Location";
  if (payload.location_id) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const response = await admin.graphql(`
        query {
          location(id: "gid://shopify/Location/${payload.location_id}") {
            name
          }
        }
      `);
      const data = await response.json();
      if (data.data?.location?.name) {
        locationName = data.data.location.name;
      }
    } catch (e) {
      console.error("Failed to fetch location name:", e);
    }
  }

  // Save the raw event for the charts BEFORE checking rules!
  // This ensures the chronological UI populates even if rules aren't set up yet.
  await prisma.inventoryEvent.create({
    data: {
      shop,
      inventoryItemId: payload.inventory_item_id.toString(),
      available: payload.available,
      isProtected: false,
      reason: `Location: ${locationName}`
    }
  });

  if (activeRules.length === 0) {
    return new Response("No active rules", { status: 200 });
  }

  // Fetch shop configuration for business hours
  const config = await prisma.appConfiguration.findUnique({
    where: { shop }
  });

  const businessStart = config?.businessStart || "09:00";
  const businessEnd = config?.businessEnd || "17:00";

  // Rule 1: Fringe Hours Activity
  let fringeTriggered = false;
  const fringeRule = activeRules.find(r => r.triggerType === "time_fringe");
  if (fringeRule) {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeStr = `${currentHour.toString().padStart(2, '0')}:${currentMinute.toString().padStart(2, '0')}`;
    
    if (currentTimeStr < businessStart || currentTimeStr > businessEnd) {
      fringeTriggered = true;
      const details = `Inventory modified to ${payload.available} outside business hours (${businessStart}-${businessEnd}).`;
      
      await prisma.triggeredAlert.create({
        data: {
          shop,
          ruleId: fringeRule.id,
          person: "System/Worker", 
          productName: `Item ID: ${payload.inventory_item_id}`,
          details,
          status: "active"
        }
      });

      // Email Dispatcher
      const emailEnabled = config?.emailAlertsEnabled ?? true;
      if (emailEnabled && config?.alertEmailAddress) {
        const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
        try {
          await resend.emails.send({
            from: "Security Alerts <onboarding@resend.dev>",
            to: emailList,
            subject: `🚨 SECURITY ALERT: ${fringeRule.name}`,
            html: `
              <h2>${fringeRule.name} Triggered</h2>
              <p><strong>Store:</strong> ${shop}</p>
              <p><strong>Date & Time:</strong> ${new Date().toLocaleString()}</p>
              <p><strong>Product ID:</strong> ${payload.inventory_item_id}</p>
              <p><strong>Details:</strong> ${details}</p>
            `
          });
        } catch (err) {
          console.error("Failed to send fringe email alert", err);
        }
      }
    }
  }

  // Rules 2 & 3: Unmatched Consumption
  // We use a brief timeout to allow the ORDERS_CREATE webhook (which may arrive milliseconds later) to buffer.
  const unmatchedRule = activeRules.find(r => r.triggerType === "unmatched");
  let isUnmatched = false;
  
  if (unmatchedRule) {
    // Determine if inventory dropped
    const previousEvent = await prisma.inventoryEvent.findFirst({
      where: { shop, inventoryItemId: payload.inventory_item_id.toString() },
      orderBy: { time: 'desc' }
    });

    if (previousEvent && payload.available < previousEvent.available) {
      const dropQuantity = previousEvent.available - payload.available;
      
      // Background worker: wait 5 seconds to ensure Shopify order hooks have settled
      setTimeout(async () => {
        const timeWindow = new Date(Date.now() - 60000); // Past 60 seconds
        
        // Search the short-term memory buffer (OrderReceipt) for a matching deduction
        const match = await prisma.orderReceipt.findFirst({
          where: {
            shop,
            time: { gte: timeWindow }
            // For a production app, we would match IDs precisely here.
          }
        });

        if (!match) {
          isUnmatched = true;
          const details = `Detected a drop of ${dropQuantity} units without a corresponding order receipt.`;
          
          await prisma.triggeredAlert.create({
            data: {
              shop,
              ruleId: unmatchedRule.id,
              person: "Unknown", 
              productName: `Item ID: ${payload.inventory_item_id}`,
              details,
              status: "active"
            }
          });

          // Email Dispatcher
          const emailEnabled = config?.emailAlertsEnabled ?? true;
          if (emailEnabled && config?.alertEmailAddress) {
            const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
            try {
              await resend.emails.send({
                from: "Security Alerts <onboarding@resend.dev>",
                to: emailList,
                subject: `🚨 SECURITY ALERT: ${unmatchedRule.name}`,
                html: `
                  <h2>${unmatchedRule.name} Triggered</h2>
                  <p><strong>Store:</strong> ${shop}</p>
                  <p><strong>Date & Time:</strong> ${new Date().toLocaleString()}</p>
                  <p><strong>Product ID:</strong> ${payload.inventory_item_id}</p>
                  <p><strong>Details:</strong> ${details}</p>
                `
              });
            } catch (err) {
              console.error("Failed to send unmatched email alert", err);
            }
          }
        } else {
          console.log(`[Reconciliation Engine] ✅ Successfully reconciled inventory drop of ${dropQuantity} units with Order #${match.orderId}`);
        }
      }, 5000);
    }
  }

  // Rule 4: High-Velocity Corrections
  const velocityRule = activeRules.find(r => r.triggerType === "velocity");
  if (velocityRule) {
    // Determine custom limits, fallback to defaults
    const windowSeconds = parseInt(velocityRule.timeOpen || "60", 10);
    const requiredAdjustments = parseInt(velocityRule.quantityThreshold || "3", 10); // 3 unique availables = 2 adjustments
    const timeWindowMs = windowSeconds * 1000;

    const recentEvents = await prisma.inventoryEvent.findMany({
      where: {
        shop,
        inventoryItemId: payload.inventory_item_id.toString(),
        time: { gte: new Date(Date.now() - timeWindowMs) }
      },
      select: { available: true }
    });

    const realAdjustmentsCount = new Set(recentEvents.map(e => e.available)).size;

    if (realAdjustmentsCount > requiredAdjustments) {
      const details = `Detected ${realAdjustmentsCount - 1} rapid adjustments for this item within ${windowSeconds} seconds. Exceeds your threshold of ${requiredAdjustments}.`;
      
      await prisma.triggeredAlert.create({
        data: {
          shop,
          ruleId: velocityRule.id,
          person: "System/Worker",
          productName: `Item ID: ${payload.inventory_item_id}`,
          details,
          status: "active"
        }
      });

      const emailEnabled = config?.emailAlertsEnabled ?? true;
      if (emailEnabled && config?.alertEmailAddress) {
        const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
        try {
          await resend.emails.send({
            from: "Security Alerts <onboarding@resend.dev>",
            to: emailList,
            subject: `🚨 SECURITY ALERT: ${velocityRule.name}`,
            html: `
              <h2>${velocityRule.name} Triggered</h2>
              <p><strong>Store:</strong> ${shop}</p>
              <p><strong>Date & Time:</strong> ${new Date().toLocaleString()}</p>
              <p><strong>Product ID:</strong> ${payload.inventory_item_id}</p>
              <p><strong>Details:</strong> ${details}</p>
            `
          });
        } catch (err) {
          console.error("Failed to send velocity email alert", err);
        }
      }
    }
  }

  // Rule 3: Manual Correction Spike
  const manualCorrectionRule = activeRules.find(r => r.triggerType === "manual_correction");
  if (manualCorrectionRule) {
    const threshold = parseInt(manualCorrectionRule.quantityThreshold || "5", 10);
    
    // Find the most recent event with a DIFFERENT available value.
    // Shopify fires 2 webhooks per change (one per location dimension), 
    // so skip:1 would just find the duplicate, not the true previous level.
    const prevEvent = await prisma.inventoryEvent.findFirst({
      where: {
        shop,
        inventoryItemId: payload.inventory_item_id.toString(),
        available: { not: payload.available }
      },
      orderBy: { time: 'desc' },
    });

    if (prevEvent) {
      const delta = Math.abs(payload.available - prevEvent.available);
      
      if (delta >= threshold) {
        const direction = payload.available > prevEvent.available ? 'increased' : 'decreased';
        const details = `Single adjustment of ${delta} units ${direction} (${prevEvent.available} → ${payload.available}). Exceeds threshold of ${threshold}.`;
        
        await prisma.triggeredAlert.create({
          data: {
            shop,
            ruleId: manualCorrectionRule.id,
            person: "System/Worker",
            productName: `Item ID: ${payload.inventory_item_id}`,
            details,
            status: "active"
          }
        });

        // Email Dispatcher
        const emailEnabled = config?.emailAlertsEnabled ?? true;
        if (emailEnabled && config?.alertEmailAddress) {
          const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
          try {
            await resend.emails.send({
              from: "Security Alerts <onboarding@resend.dev>",
              to: emailList,
              subject: `🚨 SECURITY ALERT: ${manualCorrectionRule.name}`,
              html: `
                <h2>${manualCorrectionRule.name} Triggered</h2>
                <p><strong>Store:</strong> ${shop}</p>
                <p><strong>Date & Time:</strong> ${new Date().toLocaleString()}</p>
                <p><strong>Product ID:</strong> ${payload.inventory_item_id}</p>
                <p><strong>Details:</strong> ${details}</p>
              `
            });
          } catch (err) {
            console.error("Failed to send manual correction email alert", err);
          }
        }
      }
    }
  }

  // Rule 5: Low Stock Alert
  const lowStockRules = activeRules.filter(r => r.triggerType === "low_stock");
  for (const rule of lowStockRules) {
    const threshold = parseInt(rule.quantityThreshold || "10", 10);
    const targetIds: string[] = rule.targetProductIds ? JSON.parse(rule.targetProductIds) : [];
    const itemId = payload.inventory_item_id.toString();

    // If targets are specified, only monitor those products. Otherwise monitor all.
    if (targetIds.length > 0 && !targetIds.includes(itemId)) {
      continue;
    }

    if (payload.available <= threshold && payload.available >= 0) {
      // Prevent duplicate alerts: check if we already alerted for this item in the last 24 hours
      const recentLowStockAlert = await prisma.triggeredAlert.findFirst({
        where: {
          shop,
          ruleId: rule.id,
          productName: { contains: itemId },
          time: { gte: new Date(Date.now() - 86400000) } // 24 hours
        }
      });

      if (!recentLowStockAlert) {
        // Fetch product name for the alert
        let productLabel = `Item ID: ${itemId}`;
        try {
          const { admin } = await unauthenticated.admin(shop);
          const prodResp = await admin.graphql(`
            query {
              inventoryItem(id: "gid://shopify/InventoryItem/${itemId}") {
                variant { displayName sku product { title } }
              }
            }
          `);
          const prodData = await prodResp.json();
          const variant = prodData.data?.inventoryItem?.variant;
          if (variant) {
            productLabel = variant.product?.title || variant.displayName || productLabel;
            if (variant.sku) productLabel += ` (SKU: ${variant.sku})`;
          }
        } catch (err) {
          console.error("Failed to fetch product name for low stock alert:", err);
        }

        const stockStatus = payload.available === 0 ? "OUT OF STOCK" : `LOW STOCK: ${payload.available} remaining`;
        const details = `${stockStatus}. Threshold is ${threshold} units.`;

        await prisma.triggeredAlert.create({
          data: {
            shop,
            ruleId: rule.id,
            person: "System",
            productName: productLabel,
            details,
            status: "active"
          }
        });

        // Email Dispatcher
        const emailEnabled = config?.emailAlertsEnabled ?? true;
        if (emailEnabled && config?.alertEmailAddress) {
          const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
          const emoji = payload.available === 0 ? "🚫" : "⚠️";
          try {
            await resend.emails.send({
              from: "Security Alerts <onboarding@resend.dev>",
              to: emailList,
              subject: `${emoji} ${stockStatus}: ${productLabel}`,
              html: `
                <h2>${rule.name}</h2>
                <p><strong>Store:</strong> ${shop}</p>
                <p><strong>Product:</strong> ${productLabel}</p>
                <p><strong>Current Stock:</strong> ${payload.available} units</p>
                <p><strong>Threshold:</strong> ${threshold} units</p>
                <p><strong>Date & Time:</strong> ${new Date().toLocaleString()}</p>
                <p><strong>Location:</strong> ${locationName}</p>
              `
            });
          } catch (err) {
            console.error("Failed to send low stock email alert", err);
          }
        }
        // Auto-create draft PO if enabled
        if (config?.poAutoCreateOnLowStock) {
          try {
            // Check if a draft PO already exists for this item
            const existingDraftPO = await prisma.purchaseOrder.findFirst({
              where: {
                shop,
                status: 'draft',
                lineItems: { some: { inventoryItemId: itemId } }
              }
            });

            if (!existingDraftPO) {
              // Get reorder config for quantity
              const reorderConfig = await prisma.reorderConfig.findFirst({
                where: { shop, inventoryItemId: itemId }
              });
              const globalConfig = await prisma.reorderConfig.findFirst({
                where: { shop, inventoryItemId: '__GLOBAL__' }
              });
              const orderQty = reorderConfig?.minOrderQty || globalConfig?.minOrderQty || parseInt(rule.quantityThreshold || '10', 10) * 2;

              // Find the last supplier used for this product
              const lastPO = await prisma.purchaseOrder.findFirst({
                where: { shop, lineItems: { some: { inventoryItemId: itemId } } },
                orderBy: { createdAt: 'desc' },
                include: { supplier: true }
              });

              if (lastPO?.supplier) {
                // Generate PO number
                const year = new Date().getFullYear();
                const lastPONum = await prisma.purchaseOrder.findFirst({
                  where: { shop, poNumber: { startsWith: `PO-${year}-` } },
                  orderBy: { poNumber: 'desc' }
                });
                const nextSeq = lastPONum ? parseInt(lastPONum.poNumber.split('-')[2], 10) + 1 : 1;
                const poNumber = `PO-${year}-${nextSeq.toString().padStart(4, '0')}`;

                await prisma.purchaseOrder.create({
                  data: {
                    shop,
                    poNumber,
                    supplierId: lastPO.supplier.id,
                    createdBy: 'System (Low Stock Alert)',
                    notes: `Auto-generated: ${productLabel} dropped to ${payload.available} units (threshold: ${threshold})`,
                    totalUnits: orderQty,
                    totalCost: 0,
                    lineItems: {
                      create: [{
                        inventoryItemId: itemId,
                        productName: productLabel,
                        sku: '',
                        orderedQty: orderQty,
                        unitCost: 0
                      }]
                    }
                  }
                });
                console.log(`[AutoPO] Created draft PO ${poNumber} for ${productLabel} (${orderQty} units)`);

                // Send email notification to PO alert recipients
                if (config?.poAlertEmails) {
                  const poRecipients = config.poAlertEmails.split(',').map((e: string) => e.trim()).filter((e: string) => e);
                  if (poRecipients.length > 0) {
                    try {
                      await resend.emails.send({
                        from: "Purchase Orders <onboarding@resend.dev>",
                        to: poRecipients,
                        subject: `📦 Draft PO ${poNumber} Created — Low Stock Alert [${shop}]`,
                        html: `
                          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
                            <h2 style="color:#1a1a1a">📦 Auto-Generated Purchase Order</h2>
                            <p style="color:#666">A draft PO has been automatically created because stock dropped below the alert threshold.</p>
                            <table style="width:100%;border-collapse:collapse;margin:16px 0">
                              <tr><td style="padding:8px;color:#666"><strong>PO Number:</strong></td><td style="padding:8px">${poNumber}</td></tr>
                              <tr><td style="padding:8px;color:#666"><strong>Product:</strong></td><td style="padding:8px">${productLabel}</td></tr>
                              <tr><td style="padding:8px;color:#666"><strong>Order Qty:</strong></td><td style="padding:8px">${orderQty} units</td></tr>
                              <tr><td style="padding:8px;color:#666"><strong>Current Stock:</strong></td><td style="padding:8px">${payload.available} units</td></tr>
                              <tr><td style="padding:8px;color:#666"><strong>Threshold:</strong></td><td style="padding:8px">${threshold} units</td></tr>
                              <tr><td style="padding:8px;color:#666"><strong>Supplier:</strong></td><td style="padding:8px">${lastPO.supplier.name}</td></tr>
                            </table>
                            <p style="color:#666">Log into <strong>Shopify Protection</strong> → <strong>Purchase Orders</strong> to review and approve.</p>
                            <p style="color:#999;font-size:12px">Store: ${shop} · ${new Date().toLocaleString()}</p>
                          </div>
                        `
                      });
                    } catch (emailErr) {
                      console.error('[AutoPO] Failed to send PO notification email:', emailErr);
                    }
                  }
                }
              }
            }
          } catch (err) {
            console.error('Failed to auto-create PO:', err);
          }
        }
      }
    }
  }

  return new Response("Inventory Webhook processed", { status: 200 });
};
