import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY || "re_12345");

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Unhandled webhook topic", { status: 404 });
  }

  const activeRules = await prisma.securityRule.findMany({
    where: { shop, isActive: true }
  });

  const config = await prisma.appConfiguration.findUnique({
    where: { shop }
  });

  let personName = payload.source_name === "web" ? "Online Customer" : "Shopify Admin";
  if (payload.source_name === "pos") {
    personName = "POS Staff"; 
    if (payload.user_id) {
       personName = `POS Staff (ID: ${payload.user_id})`;
    }
  } else if (payload.source_name === "shopify_draft_order") {
    personName = "Manual Invoice";
  }

  // Scan custom invoice fields (Cart Attributes) for Commission/Staff names
  if (payload.note_attributes && Array.isArray(payload.note_attributes)) {
    for (const attr of payload.note_attributes) {
      const key = attr.name ? attr.name.toLowerCase() : "";
      if (key.includes("rep") || key.includes("staff") || key.includes("commission") || key.includes("person")) {
        personName = attr.value;
        break;
      }
    }
  }

  // Fallback: Scan order tags for things like "Staff: Sue" or "Rep_John"
  if (payload.tags && typeof payload.tags === 'string') {
    const tags = payload.tags.split(',').map(t => t.trim().toLowerCase());
    for (const t of tags) {
      if (t.startsWith("staff:") || t.startsWith("rep:")) {
        // e.g., "Staff: Sue" -> Extracts "Sue"
        personName = t.split(':')[1].trim();
        // Capitalize the first letter for clean UI
        personName = personName.charAt(0).toUpperCase() + personName.slice(1);
        break;
      }
    }
  }

  const transactionId = payload.name; // This is the order name like #1001
  const lineItems = payload.line_items || [];

  // Wait 3 seconds to ensure the inventory webhook has time to log the event first
  await new Promise(resolve => setTimeout(resolve, 3000));

  const { admin } = await unauthenticated.admin(shop);

  for (const item of lineItems) {
    if (item.variant_id) {
      // Query the GraphQL API to get the inventory_item_id for this variant
      try {
        const response = await admin.graphql(`
          query {
            productVariant(id: "gid://shopify/ProductVariant/${item.variant_id}") {
              inventoryItem { id }
            }
          }
        `);
        const data = await response.json();
        const inventoryItemId = data.data?.productVariant?.inventoryItem?.id;

        if (inventoryItemId) {
          // Strip gid prefix: "gid://shopify/InventoryItem/12345" -> "12345"
          const numericItemId = inventoryItemId.replace('gid://shopify/InventoryItem/', '');
          // Find the most recent inventory event within the last 60s for this EXACT item
          const recentEvent = await prisma.inventoryEvent.findFirst({
            where: {
              shop,
              inventoryItemId: numericItemId,
              transactionId: null,
              time: {
                gte: new Date(Date.now() - 60000)
              }
            },
            orderBy: {
              time: 'desc'
            }
          });

          if (recentEvent) {
            await prisma.inventoryEvent.update({
              where: { id: recentEvent.id },
              data: {
                transactionId,
                reason: `${payload.source_name === 'pos' ? 'Local Store Sale' : 'Internet Sale'} - ${personName}`
              }
            });
          }
        }
      } catch (err) {
        console.error("Failed to map order to inventory item:", err);
      }
    }
  }

  // Evaluate High Value / Bulk Order rule
  const highValueRule = activeRules.find(r => r.triggerType === "high_value_order");
  if (highValueRule) {
    const revenueThreshold = highValueRule.quantityThreshold ? parseFloat(highValueRule.quantityThreshold) : null;
    const qtyThreshold = highValueRule.timeOpen ? parseInt(highValueRule.timeOpen, 10) : null;
    
    let isTriggered = false;
    let detailsStr = "";

    const orderTotal = parseFloat(payload.total_price || "0");
    const totalItemCount = lineItems.reduce((acc: number, item: any) => acc + (item.quantity || 0), 0);

    const meetsRevenue = !revenueThreshold || orderTotal >= revenueThreshold;
    const meetsQuantity = !qtyThreshold || totalItemCount >= qtyThreshold;

    // Must meet BOTH conditions if both are defined. If only one is defined, must meet that one.
    if ((revenueThreshold || qtyThreshold) && meetsRevenue && meetsQuantity) {
      isTriggered = true;
      detailsStr = `Order value of $${orderTotal.toFixed(2)} and total item count of ${totalItemCount} exceeded risk thresholds.`;
    }

    if (isTriggered) {
      await prisma.triggeredAlert.create({
        data: {
          shop,
          ruleId: highValueRule.id,
          person: personName,
          productName: `Order ${transactionId}`,
          details: `Authorized fulfillment flagged: ${detailsStr}`,
          status: "active",
          transactionId: transactionId
        }
      });

      let holdSuccessStr = "";
      if (highValueRule.haltFulfillment && config?.planType === 'premium') {
        try {
          const foResponse = await admin.graphql(`
            query {
              order(id: "gid://shopify/Order/${payload.id}") {
                fulfillmentOrders(first: 10) {
                  edges { node { id } }
                }
              }
            }
          `);
          const foData = await foResponse.json();
          const fulfillmentOrders = foData.data?.order?.fulfillmentOrders?.edges || [];
          
          let holdsApplied = 0;
          for (const edge of fulfillmentOrders) {
            await admin.graphql(`
              mutation fulfillmentOrderHold($id: ID!) {
                fulfillmentOrderHold(
                  id: $id, 
                  fulfillmentHold: {
                    reason: OTHER, 
                    reasonNotes: "ONIT Security Engine: High Value/Bulk Rule Triggered"
                  }
                ) {
                  userErrors { message }
                }
              }
            `, { variables: { id: edge.node.id } });
            holdsApplied++;
          }
          if (holdsApplied > 0) {
            holdSuccessStr = `<p style="color: red; font-weight: bold;">🛑 ACTION TAKEN: This order has been automatically placed on HOLD in Shopify to prevent warehouse fulfillment.</p>`;
          }
        } catch (e) {
          console.error("Failed to hold fulfillment orders:", e);
          holdSuccessStr = `<p style="color: orange;">⚠️ ATTEMPTED HOLD: Tried to place order on hold but encountered an API error.</p>`;
        }
      } else if (highValueRule.haltFulfillment) {
        holdSuccessStr = `<p style="color: #888;"><em>Note: Automatic Order Hold is a Premium feature. The order is proceeding to fulfillment. Upgrade to Premium to stop these automatically.</em></p>`;
      }

      const emailEnabled = config?.emailAlertsEnabled ?? true;
      if (emailEnabled && config?.alertEmailAddress) {
        const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
        try {
          await resend.emails.send({
            from: "Security Alerts <onboarding@resend.dev>",
            to: emailList,
            subject: `🚨 SECURITY ALERT: High Value / Bulk Order Detected`,
            html: `
              <h2>High Value Order Flagged for Review</h2>
              ${holdSuccessStr}
              <p><strong>Store:</strong> ${shop}</p>
              <p><strong>Order ID:</strong> ${transactionId}</p>
              <p><strong>Customer/Origin:</strong> ${personName}</p>
              <p><strong>Details:</strong> ${detailsStr}</p>
              <p><strong>Total Value:</strong> $${orderTotal.toFixed(2)}</p>
              <p>Please review this order for potential fraud.</p>
            `
          });
        } catch (err) {
          console.error("Failed to send high value order email", err);
        }
      }
    }
  }

  // Evaluate High-Risk Shipping Address rule
  const highRiskRule = activeRules.find(r => r.triggerType === "high_risk_address");
  if (highRiskRule && payload.shipping_address) {
    const blocklistRaw = highRiskRule.quantityThreshold || "";
    const blocklist = blocklistRaw.split(",").map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
    
    if (blocklist.length > 0) {
      const address1 = (payload.shipping_address.address1 || "").toLowerCase();
      const address2 = (payload.shipping_address.address2 || "").toLowerCase();
      const zip = (payload.shipping_address.zip || "").toLowerCase();
      const city = (payload.shipping_address.city || "").toLowerCase();
      
      const fullAddressString = `${address1} ${address2} ${city} ${zip}`;
      
      let matchedTerm = null;
      for (const term of blocklist) {
        if (fullAddressString.includes(term)) {
          matchedTerm = term;
          break;
        }
      }
      
      if (matchedTerm) {
        let holdSuccessStr = "";
        
        if (highRiskRule.haltFulfillment && config?.planType === 'premium') {
          try {
            const foResponse = await admin.graphql(`
              query {
                order(id: "gid://shopify/Order/${payload.id}") {
                  fulfillmentOrders(first: 10) {
                    edges { node { id } }
                  }
                }
              }
            `);
            const foData = await foResponse.json();
            const fulfillmentOrders = foData.data?.order?.fulfillmentOrders?.edges || [];
            
            let holdsApplied = 0;
            for (const edge of fulfillmentOrders) {
              await admin.graphql(`
                mutation fulfillmentOrderHold($id: ID!) {
                  fulfillmentOrderHold(
                    id: $id, 
                    fulfillmentHold: {
                      reason: OTHER, 
                      reasonNotes: "ONIT Security Engine: Fraudulent Shipping Destination Blocklist"
                    }
                  ) {
                    userErrors { message }
                  }
                }
              `, { variables: { id: edge.node.id } });
              holdsApplied++;
            }
            if (holdsApplied > 0) {
              holdSuccessStr = `<p style="color: red; font-weight: bold;">🛑 ACTION TAKEN: Order placed on HOLD. Matched Blocklist: "${matchedTerm}"</p>`;
            }
          } catch (e) {
            console.error("Failed to hold fulfillment orders for fraud:", e);
            holdSuccessStr = `<p style="color: orange;">⚠️ ATTEMPTED HOLD: Tried to place order on hold but encountered an API error.</p>`;
          }
        } else if (highRiskRule.haltFulfillment) {
          holdSuccessStr = `<p style="color: #888;"><em>Note: Automatic Order Hold is a Premium feature. The order is proceeding to fulfillment. Upgrade to Premium to stop these automatically.</em></p>`;
        }
        
        const detailsStr = `Shipping address matched fraud blocklist term: "${matchedTerm}" (Address: ${payload.shipping_address.address1}, ${payload.shipping_address.zip})`;

        await prisma.triggeredAlert.create({
          data: {
            shop,
            ruleId: highRiskRule.id,
            person: personName,
            productName: `Order ${transactionId}`,
            details: detailsStr,
            status: "active",
            transactionId: transactionId
          }
        });

        const emailEnabled = config?.emailAlertsEnabled ?? true;
        if (emailEnabled && config?.alertEmailAddress) {
          const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
          try {
            await resend.emails.send({
              from: "Security Alerts <onboarding@resend.dev>",
              to: emailList,
              subject: `🚨 FRAUD ALERT: High Risk Address Detected`,
              html: `
                <h2>Fraudulent Shipping Address Flagged</h2>
                ${holdSuccessStr}
                <p><strong>Store:</strong> ${shop}</p>
                <p><strong>Order ID:</strong> ${transactionId}</p>
                <p><strong>Customer/Origin:</strong> ${personName}</p>
                <p><strong>Details:</strong> ${detailsStr}</p>
                <p>Please review this order before fulfillment to prevent chargebacks.</p>
              `
            });
          } catch (err) {
            console.error("Failed to send fraud alert email", err);
          }
        }
      }
    }
  }
  // Evaluate Location Constraint Violation Rule
  const locationRule = activeRules.find(r => r.triggerType === "location_violation");
  if (locationRule) {
    const protectedLocationsRaw = locationRule.quantityThreshold || "";
    const protectedLocations = protectedLocationsRaw.split(",").map(s => s.trim().toLowerCase()).filter(s => s.length > 0);

    if (protectedLocations.length > 0) {
      try {
        const foResponse = await admin.graphql(`
          query {
            order(id: "gid://shopify/Order/${payload.id}") {
              fulfillmentOrders(first: 10) {
                edges {
                  node {
                    id
                    assignedLocation {
                      location {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        `);
        const foData = await foResponse.json();
        const fulfillmentOrders = foData.data?.order?.fulfillmentOrders?.edges || [];

        for (const edge of fulfillmentOrders) {
          const locationName = (edge.node.assignedLocation?.location?.name || "").toLowerCase();
          
          let isProtected = false;
          for (const term of protectedLocations) {
            if (locationName.includes(term)) {
              isProtected = true;
              break;
            }
          }

          if (isProtected) {
            let holdSuccessStr = "";
            
            if (locationRule.haltFulfillment && config?.planType === 'premium') {
              try {
                await admin.graphql(`
                  mutation fulfillmentOrderHold($id: ID!) {
                    fulfillmentOrderHold(
                      id: $id, 
                      fulfillmentHold: {
                        reason: OTHER, 
                        reasonNotes: "ONIT Security Engine: Location Constraint Violation. This order was routed to a protected retail store."
                      }
                    ) {
                      userErrors { message }
                    }
                  }
                `, { variables: { id: edge.node.id } });
                
                holdSuccessStr = `<p style="color: red; font-weight: bold;">🛑 ACTION TAKEN: Order placed on HOLD to prevent retail inventory stealing.</p>`;
              } catch (e) {
                console.error("Failed to hold fulfillment order for location violation:", e);
                holdSuccessStr = `<p style="color: orange;">⚠️ ATTEMPTED HOLD: Tried to place order on hold but encountered an API error.</p>`;
              }
            } else if (locationRule.haltFulfillment) {
              holdSuccessStr = `<p style="color: #888;"><em>Note: Automatic Order Hold is a Premium feature. The order is proceeding to fulfillment. Upgrade to Premium to stop these automatically.</em></p>`;
            }

            const detailsStr = `Internet order incorrectly routed to protected retail location: "${edge.node.assignedLocation?.location?.name}".`;

            await prisma.triggeredAlert.create({
              data: {
                shop,
                ruleId: locationRule.id,
                person: "Shopify Routing Engine",
                productName: `Order ${transactionId}`,
                details: detailsStr,
                status: "active",
                transactionId: transactionId
              }
            });

            const emailEnabled = config?.emailAlertsEnabled ?? true;
            if (emailEnabled && config?.alertEmailAddress) {
              const emailList = config.alertEmailAddress.split(',').map(e => e.trim()).filter(e => e.length > 0);
              try {
                await resend.emails.send({
                  from: "Security Alerts <onboarding@resend.dev>",
                  to: emailList,
                  subject: `🚨 INVENTORY ALERT: Protected Location Violation`,
                  html: `
                    <h2>Retail Inventory At Risk</h2>
                    ${holdSuccessStr}
                    <p><strong>Store:</strong> ${shop}</p>
                    <p><strong>Order ID:</strong> ${transactionId}</p>
                    <p><strong>Details:</strong> ${detailsStr}</p>
                    <p>Please review this order in Shopify and re-route it to an appropriate warehouse.</p>
                  `
                });
              } catch (err) {
                console.error("Failed to send location violation email", err);
              }
            }
          }
        }
      } catch (err) {
        console.error("Failed to query fulfillment orders for location violation:", err);
      }
    }
  }

  return new Response("OK", { status: 200 });
};
