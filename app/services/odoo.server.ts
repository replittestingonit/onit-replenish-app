import prisma from "../db.server";

interface OdooConfig {
  odooUrl: string;
  odooDatabase: string;
  odooApiKey: string;
  odooUserId: number | null;
}

/**
 * Odoo JSON-RPC 2.0 — authenticate and get user ID
 */
export async function odooAuthenticate(config: OdooConfig): Promise<number> {
  const response = await fetch(`${config.odooUrl}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "common",
        method: "authenticate",
        args: [config.odooDatabase, "", config.odooApiKey, {}]
      },
      id: Date.now()
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(`Odoo auth failed: ${data.error.message || JSON.stringify(data.error)}`);
  if (!data.result) throw new Error("Odoo authentication failed — invalid credentials or API key");
  return data.result as number;
}

/**
 * Core JSON-RPC call to Odoo's object service
 */
async function odooExecute(
  config: OdooConfig,
  model: string,
  method: string,
  args: any[],
  kwargs: Record<string, any> = {}
): Promise<any> {
  if (!config.odooUserId) {
    throw new Error("Odoo user ID not set — authenticate first");
  }
  const response = await fetch(`${config.odooUrl}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "object",
        method: "execute_kw",
        args: [config.odooDatabase, config.odooUserId, config.odooApiKey, model, method, args, kwargs]
      },
      id: Date.now()
    })
  });
  const data = await response.json();
  if (data.error) {
    const msg = data.error.data?.message || data.error.message || JSON.stringify(data.error);
    throw new Error(`Odoo RPC error (${model}.${method}): ${msg}`);
  }
  return data.result;
}

/**
 * Find or create a supplier (res.partner) in Odoo by name
 */
async function findOrCreateOdooPartner(config: OdooConfig, supplierName: string, email?: string | null): Promise<number> {
  // Search by name first
  const existing = await odooExecute(config, "res.partner", "search_read", [
    [["name", "=", supplierName], ["supplier_rank", ">", 0]]
  ], { fields: ["id"], limit: 1 });

  if (existing && existing.length > 0) return existing[0].id;

  // Create new partner
  const partnerData: any = { name: supplierName, supplier_rank: 1 };
  if (email) partnerData.email = email;
  return await odooExecute(config, "res.partner", "create", [partnerData]);
}

/**
 * Find Odoo product by SKU (default_code)
 */
async function findOdooProductBySku(config: OdooConfig, sku: string): Promise<number | null> {
  if (!sku) return null;
  const results = await odooExecute(config, "product.product", "search_read", [
    [["default_code", "=", sku]]
  ], { fields: ["id"], limit: 1 });
  return results && results.length > 0 ? results[0].id : null;
}

/**
 * Push an approved PO to Odoo — creates a purchase.order
 */
export async function pushPOToOdoo(
  shop: string,
  poId: string,
  config: OdooConfig
): Promise<{ success: boolean; odooPOId?: number; error?: string }> {
  try {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { supplier: true, lineItems: true }
    });
    if (!po) return { success: false, error: "PO not found" };

    // Mark as syncing
    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: { odooSyncStatus: "pending" }
    });

    // 1. Find or create supplier in Odoo
    const partnerId = await findOrCreateOdooPartner(
      config, po.supplier.name, po.supplier.email
    );

    // Cache Odoo partner ID on our supplier
    await prisma.supplier.update({
      where: { id: po.supplier.id },
      data: { odooPartnerId: partnerId }
    });

    // 2. Build order lines
    const orderLines: any[] = [];
    for (const li of po.lineItems) {
      // Try to match product by SKU
      let odooProductId = li.odooProductId;
      if (!odooProductId && li.sku) {
        odooProductId = await findOdooProductBySku(config, li.sku);
        if (odooProductId) {
          await prisma.purchaseOrderLineItem.update({
            where: { id: li.id },
            data: { odooProductId }
          });
        }
      }

      const lineData: any = {
        product_qty: li.orderedQty,
        price_unit: li.unitCost,
        name: li.productName,
      };
      if (odooProductId) lineData.product_id = odooProductId;

      // Odoo requires (0, 0, {values}) format for one2many creation
      orderLines.push([0, 0, lineData]);
    }

    // 3. Create purchase.order in Odoo
    const odooPOId = await odooExecute(config, "purchase.order", "create", [{
      partner_id: partnerId,
      origin: po.poNumber,
      notes: po.notes || `Synced from ONIT — ${po.poNumber}`,
      order_line: orderLines,
      date_planned: po.expectedDate ? po.expectedDate.toISOString().split("T")[0] : undefined
    }]);

    // 4. Update our PO with Odoo reference
    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: {
        odooPOId: odooPOId,
        odooSyncStatus: "synced",
        odooSyncError: null
      }
    });

    console.log(`[Odoo] Pushed PO ${po.poNumber} → Odoo ID: ${odooPOId}`);
    return { success: true, odooPOId };

  } catch (err: any) {
    console.error(`[Odoo] Failed to push PO:`, err);
    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: { odooSyncStatus: "error", odooSyncError: err.message }
    });
    return { success: false, error: err.message };
  }
}

/**
 * Pull receiving updates from Odoo for a specific PO
 */
export async function pullOdooReceiving(
  shop: string,
  poId: string,
  config: OdooConfig
): Promise<{ success: boolean; updatedLines: number; error?: string }> {
  try {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { lineItems: true }
    });
    if (!po || !po.odooPOId) return { success: false, error: "No linked Odoo PO" };

    // Read Odoo PO lines
    const odooLines = await odooExecute(config, "purchase.order.line", "search_read", [
      [["order_id", "=", po.odooPOId]]
    ], { fields: ["id", "product_id", "product_qty", "qty_received", "name"] });

    let updatedLines = 0;
    for (const odooLine of odooLines) {
      // Match by product name or Odoo product ID
      const matchingLi = po.lineItems.find(li =>
        (li.odooProductId && li.odooProductId === odooLine.product_id?.[0]) ||
        li.productName === odooLine.name
      );

      if (matchingLi && odooLine.qty_received > matchingLi.receivedQty) {
        await prisma.purchaseOrderLineItem.update({
          where: { id: matchingLi.id },
          data: {
            receivedQty: Math.floor(odooLine.qty_received),
            receivedBy: "Odoo Sync",
            receivedAt: new Date()
          }
        });
        updatedLines++;
      }
    }

    // Recalculate PO totals
    if (updatedLines > 0) {
      const updatedPO = await prisma.purchaseOrder.findUnique({
        where: { id: poId },
        include: { lineItems: true }
      });
      if (updatedPO) {
        const totalReceived = updatedPO.lineItems.reduce((s, li) => s + li.receivedQty, 0);
        const allReceived = updatedPO.lineItems.every(li => li.receivedQty >= li.orderedQty);
        await prisma.purchaseOrder.update({
          where: { id: poId },
          data: {
            receivedUnits: totalReceived,
            status: allReceived ? 'received' : 'partially_received'
          }
        });
      }
    }

    return { success: true, updatedLines };
  } catch (err: any) {
    console.error(`[Odoo] Failed to pull receiving:`, err);
    return { success: false, updatedLines: 0, error: err.message };
  }
}

/**
 * Cancel a PO in Odoo
 */
export async function cancelOdooPO(config: OdooConfig, odooPOId: number): Promise<void> {
  try {
    await odooExecute(config, "purchase.order", "button_cancel", [[odooPOId]]);
    console.log(`[Odoo] Cancelled PO ID: ${odooPOId}`);
  } catch (err) {
    console.error(`[Odoo] Failed to cancel PO:`, err);
  }
}

/**
 * Test Odoo connection — returns version info
 */
export async function testOdooConnection(url: string, db: string, apiKey: string): Promise<{ success: boolean; version?: string; userId?: number; error?: string }> {
  try {
    // Test server version
    const versionRes = await fetch(`${url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service: "common", method: "version", args: [] },
        id: 1
      })
    });
    const versionData = await versionRes.json();
    if (versionData.error) throw new Error(versionData.error.message);
    const version = versionData.result?.server_version || "Unknown";

    // Test authentication
    const userId = await odooAuthenticate({ odooUrl: url, odooDatabase: db, odooApiKey: apiKey, odooUserId: null });

    return { success: true, version, userId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
