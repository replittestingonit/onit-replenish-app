import prisma from "../db.server";

interface SalesDataPoint {
  date: string; // YYYY-MM-DD
  quantity: number;
}

interface ForecastResult {
  inventoryItemId: string;
  productName: string;
  sku: string | null;
  avgDailySales: number;
  trendDirection: "rising" | "stable" | "declining";
  trendRate: number;
  seasonalityIndex: number;
  forecast30d: number;
  forecast60d: number;
  forecast90d: number;
  currentStock: number;
  daysUntilStockout: number | null;
  reorderPoint: number | null;
  suggestedQty: number | null;
}

/**
 * Pull order line items from the last N days via Shopify GraphQL API
 * and aggregate into daily sales per inventory item.
 */
async function fetchSalesHistory(
  admin: any,
  days: number = 90
): Promise<Map<string, { productName: string; sku: string | null; dailySales: SalesDataPoint[] }>> {
  const sinceDate = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
  const salesMap = new Map<string, { productName: string; sku: string | null; dailyMap: Map<string, number> }>();

  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const response = await admin.graphql(`
      query {
        orders(first: 50, query: "created_at:>='${sinceDate}' financial_status:paid"${afterClause}, sortKey: CREATED_AT) {
          edges {
            cursor
            node {
              createdAt
              lineItems(first: 50) {
                edges {
                  node {
                    quantity
                    variant {
                      inventoryItem { id }
                      sku
                      product { title }
                    }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `);

    const data = await response.json();
    const edges = data.data?.orders?.edges || [];
    hasNextPage = data.data?.orders?.pageInfo?.hasNextPage || false;

    if (edges.length > 0) {
      cursor = edges[edges.length - 1].cursor;
    } else {
      hasNextPage = false;
    }

    for (const edge of edges) {
      const order = edge.node;
      const orderDate = order.createdAt.split("T")[0]; // YYYY-MM-DD

      for (const liEdge of (order.lineItems?.edges || [])) {
        const li = liEdge.node;
        if (!li.variant?.inventoryItem?.id) continue;

        // Strip the GID prefix to get the numeric ID
        const inventoryItemId = li.variant.inventoryItem.id.replace("gid://shopify/InventoryItem/", "");
        const productName = li.variant.product?.title || "Unknown Product";
        const sku = li.variant.sku || null;
        const qty = li.quantity || 0;

        if (!salesMap.has(inventoryItemId)) {
          salesMap.set(inventoryItemId, { productName, sku, dailyMap: new Map() });
        }
        const entry = salesMap.get(inventoryItemId)!;
        entry.dailyMap.set(orderDate, (entry.dailyMap.get(orderDate) || 0) + qty);
      }
    }
  }

  // Convert dailyMap to sorted dailySales array, filling gaps with 0
  const result = new Map<string, { productName: string; sku: string | null; dailySales: SalesDataPoint[] }>();
  
  for (const [itemId, entry] of salesMap) {
    const dailySales: SalesDataPoint[] = [];
    for (let d = 0; d < days; d++) {
      const date = new Date(Date.now() - (days - d) * 86400000).toISOString().split("T")[0];
      dailySales.push({ date, quantity: entry.dailyMap.get(date) || 0 });
    }
    result.set(itemId, { productName: entry.productName, sku: entry.sku, dailySales });
  }

  return result;
}

/**
 * Calculate a simple moving average over a window
 */
function movingAverage(data: number[], window: number): number {
  if (data.length === 0) return 0;
  const slice = data.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Calculate trend via linear regression on weekly totals
 * Returns: { direction, rate (% change per week) }
 */
function calculateTrend(dailySales: SalesDataPoint[]): { direction: "rising" | "stable" | "declining"; rate: number } {
  // Group by week
  const weeklyTotals: number[] = [];
  for (let i = 0; i < dailySales.length; i += 7) {
    const week = dailySales.slice(i, i + 7);
    weeklyTotals.push(week.reduce((sum, d) => sum + d.quantity, 0));
  }

  if (weeklyTotals.length < 2) {
    return { direction: "stable", rate: 0 };
  }

  // Simple linear regression: y = mx + b
  const n = weeklyTotals.length;
  const xMean = (n - 1) / 2;
  const yMean = weeklyTotals.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (weeklyTotals[i] - yMean);
    denominator += (i - xMean) ** 2;
  }

  const slope = denominator !== 0 ? numerator / denominator : 0;
  const ratePerWeek = yMean !== 0 ? (slope / yMean) * 100 : 0;

  let direction: "rising" | "stable" | "declining" = "stable";
  if (ratePerWeek > 3) direction = "rising";
  else if (ratePerWeek < -3) direction = "declining";

  return { direction, rate: Math.round(ratePerWeek * 100) / 100 };
}

/**
 * Calculate day-of-week seasonality index
 * Returns the index for today's day of week
 */
function calculateSeasonality(dailySales: SalesDataPoint[]): number {
  const dayTotals: number[] = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
  const dayCounts: number[] = [0, 0, 0, 0, 0, 0, 0];

  for (const point of dailySales) {
    const dayOfWeek = new Date(point.date).getDay();
    dayTotals[dayOfWeek] += point.quantity;
    dayCounts[dayOfWeek]++;
  }

  const dayAverages = dayTotals.map((total, i) => dayCounts[i] > 0 ? total / dayCounts[i] : 0);
  const overallAvg = dayAverages.reduce((a, b) => a + b, 0) / 7;

  if (overallAvg === 0) return 1.0;

  const todayDow = new Date().getDay();
  return Math.round((dayAverages[todayDow] / overallAvg) * 100) / 100;
}

/**
 * Calculate sample standard deviation for variance analysis
 */
function standardDeviation(arr: number[]): number {
  if (arr.length <= 1) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Fetch current inventory levels from Shopify for given item IDs
 */
async function fetchCurrentStock(
  admin: any,
  inventoryItemIds: string[]
): Promise<Map<string, number>> {
  const stockMap = new Map<string, number>();

  // Batch in groups of 50
  for (let i = 0; i < inventoryItemIds.length; i += 50) {
    const batch = inventoryItemIds.slice(i, i + 50);
    const gids = batch.map(id => `"gid://shopify/InventoryItem/${id}"`).join(", ");

    try {
      const response = await admin.graphql(`
        query {
          nodes(ids: [${gids}]) {
            ... on InventoryItem {
              id
              inventoryLevels(first: 10) {
                edges {
                  node {
                    quantities(names: ["available"]) {
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
      `);
      const data = await response.json();
      for (const node of (data.data?.nodes || [])) {
        if (!node?.id) continue;
        const numericId = node.id.replace("gid://shopify/InventoryItem/", "");
        let totalAvailable = 0;
        for (const level of (node.inventoryLevels?.edges || [])) {
          for (const q of (level.node?.quantities || [])) {
            totalAvailable += q.quantity || 0;
          }
        }
        stockMap.set(numericId, totalAvailable);
      }
    } catch (err) {
      console.error("Failed to fetch inventory levels batch:", err);
    }
  }

  return stockMap;
}

/**
 * Main forecasting function: pull data, calculate, store results
 */
export async function runForecast(shop: string, admin: any): Promise<ForecastResult[]> {
  console.log(`[Forecast] Starting forecast calculation for ${shop}`);

  // 1. Fetch 90 days of sales history
  const salesHistory = await fetchSalesHistory(admin, 90);
  console.log(`[Forecast] Found sales data for ${salesHistory.size} products`);

  if (salesHistory.size === 0) {
    return [];
  }

  // 2. Fetch current stock levels
  const itemIds = Array.from(salesHistory.keys());
  const stockLevels = await fetchCurrentStock(admin, itemIds);

  // 3. Fetch reorder config (global default + per-product overrides)
  const reorderConfigs = await prisma.reorderConfig.findMany({ where: { shop } });
  const globalConfig = reorderConfigs.find(c => c.inventoryItemId === "__GLOBAL__");
  const defaultLeadTime = globalConfig?.leadTimeDays ?? 14;
  const defaultSafetyDays = globalConfig?.safetyStockDays ?? 7;

  // 4. Calculate forecasts for each product
  const results: ForecastResult[] = [];

  for (const [itemId, data] of salesHistory) {
    const quantities = data.dailySales.map(d => d.quantity);

    // Moving averages
    const avg30 = movingAverage(quantities, 30);
    const avg90 = movingAverage(quantities, 90);
    const avgDaily = avg30 > 0 ? avg30 : avg90; // Prefer recent data

    // Trend analysis
    const trend = calculateTrend(data.dailySales);

    // Seasonality
    const seasonalityIndex = calculateSeasonality(data.dailySales);

    // Forecast projections (base × trend factor × seasonal adjustment)
    const trendMultiplier30 = 1 + (trend.rate / 100) * (30 / 7);
    const trendMultiplier60 = 1 + (trend.rate / 100) * (60 / 7);
    const trendMultiplier90 = 1 + (trend.rate / 100) * (90 / 7);

    const forecast30d = Math.round(avgDaily * 30 * Math.max(trendMultiplier30, 0.1) * seasonalityIndex);
    const forecast60d = Math.round(avgDaily * 60 * Math.max(trendMultiplier60, 0.1) * seasonalityIndex);
    const forecast90d = Math.round(avgDaily * 90 * Math.max(trendMultiplier90, 0.1) * seasonalityIndex);

    // Stock health
    const currentStock = stockLevels.get(itemId) ?? 0;
    const daysUntilStockout = avgDaily > 0 ? Math.round((currentStock / avgDaily) * 10) / 10 : null;

    // Reorder point & suggested quantity
    const itemConfig = reorderConfigs.find(c => c.inventoryItemId === itemId);
    const leadTime = itemConfig?.leadTimeDays ?? defaultLeadTime;
    const safetyDays = itemConfig?.safetyStockDays ?? defaultSafetyDays;

    let reorderPoint: number | null = null;
    let suggestedQty: number | null = null;

    // 1. Calculate 2-Sigma Statistical Forecast
    if (avgDaily > 0) {
      const stdDev = standardDeviation(quantities);
      // Base demand during lead time + 2 standard deviations for safety
      reorderPoint = Math.ceil((avgDaily * leadTime) + (2 * stdDev * Math.sqrt(leadTime)));
    }

    // 2. Apply Manual Minimum Floor if configured
    if (itemConfig?.useManualMinimum && itemConfig.manualMinimum != null) {
      reorderPoint = reorderPoint !== null 
        ? Math.max(reorderPoint, itemConfig.manualMinimum)
        : itemConfig.manualMinimum;
    }

    // 3. Calculate Suggested Quantity if below Reorder Point
    if (reorderPoint !== null && currentStock < reorderPoint) {
      const statisticalSuggest = avgDaily > 0 ? Math.ceil(avgDaily * (leadTime + 30)) - currentStock : 0;
      const manualSuggest = reorderPoint - currentStock + (itemConfig?.minOrderQty ?? 0);
      suggestedQty = Math.max(statisticalSuggest, manualSuggest, 1);
    }

    const result: ForecastResult = {
      inventoryItemId: itemId,
      productName: data.productName,
      sku: data.sku,
      avgDailySales: Math.round(avgDaily * 100) / 100,
      trendDirection: trend.direction,
      trendRate: trend.rate,
      seasonalityIndex,
      forecast30d,
      forecast60d,
      forecast90d,
      currentStock,
      daysUntilStockout,
      reorderPoint,
      suggestedQty
    };

    results.push(result);

    // 5. Upsert the forecast record in the database
    await prisma.demandForecast.upsert({
      where: { shop_inventoryItemId: { shop, inventoryItemId: itemId } },
      update: {
        productName: data.productName,
        sku: data.sku,
        avgDailySales: result.avgDailySales,
        trendDirection: result.trendDirection,
        trendRate: result.trendRate,
        seasonalityIndex: result.seasonalityIndex,
        forecast30d: result.forecast30d,
        forecast60d: result.forecast60d,
        forecast90d: result.forecast90d,
        currentStock: result.currentStock,
        daysUntilStockout: result.daysUntilStockout,
        reorderPoint: result.reorderPoint,
        suggestedQty: result.suggestedQty,
        calculatedAt: new Date()
      },
      create: {
        shop,
        inventoryItemId: itemId,
        productName: data.productName,
        sku: data.sku,
        avgDailySales: result.avgDailySales,
        trendDirection: result.trendDirection,
        trendRate: result.trendRate,
        seasonalityIndex: result.seasonalityIndex,
        forecast30d: result.forecast30d,
        forecast60d: result.forecast60d,
        forecast90d: result.forecast90d,
        currentStock: result.currentStock,
        daysUntilStockout: result.daysUntilStockout,
        reorderPoint: result.reorderPoint,
        suggestedQty: result.suggestedQty
      }
    });
  }

  // Sort by urgency: items closest to stockout first
  results.sort((a, b) => {
    if (a.daysUntilStockout === null && b.daysUntilStockout === null) return 0;
    if (a.daysUntilStockout === null) return 1;
    if (b.daysUntilStockout === null) return -1;
    return a.daysUntilStockout - b.daysUntilStockout;
  });

  // 6. Sync forecast reorder points to low_stock SecurityRule thresholds
  // This bridges the gap between static alert thresholds and dynamic forecast values
  try {
    const lowStockRules = await prisma.securityRule.findMany({
      where: { shop, triggerType: 'low_stock', isActive: true }
    });

    for (const rule of lowStockRules) {
      const targetIds: string[] = rule.targetProductIds ? JSON.parse(rule.targetProductIds) : [];

      if (targetIds.length > 0) {
        // Product-specific rule: use the max reorder point among targeted products
        const matchingForecasts = results.filter(r =>
          targetIds.includes(r.inventoryItemId.replace('gid://shopify/InventoryItem/', ''))
        );
        if (matchingForecasts.length > 0) {
          const maxReorderPoint = Math.max(
            ...matchingForecasts.map(f => f.reorderPoint || parseInt(rule.quantityThreshold || '10', 10))
          );
          if (maxReorderPoint > 0) {
            await prisma.securityRule.update({
              where: { id: rule.id },
              data: { quantityThreshold: maxReorderPoint.toString() }
            });
          }
        }
      }
      // Global rules keep their manually-set threshold (owner's intent)
    }
  } catch (err) {
    console.error('[Forecast] Failed to sync reorder points to low stock rules:', err);
  }

  // 7. Auto-generate draft POs for products needing reorder (if enabled)
  const createdPOs: { poNumber: string; productName: string; qty: number; supplier: string; daysLeft: number | null }[] = [];
  try {
    const config = await prisma.appConfiguration.findUnique({ where: { shop } });
    if (config?.poAutoCreateOnLowStock) {
      const productsNeedingReorder = results.filter(r => r.suggestedQty !== null && r.suggestedQty > 0);

      for (const product of productsNeedingReorder) {
        const cleanItemId = product.inventoryItemId.replace('gid://shopify/InventoryItem/', '');

        // Skip if a draft PO already exists for this item
        const existingDraft = await prisma.purchaseOrder.findFirst({
          where: {
            shop,
            status: 'draft',
            lineItems: { some: { inventoryItemId: cleanItemId } }
          }
        });
        if (existingDraft) continue;

        // Find the last supplier used for this product
        const lastPO = await prisma.purchaseOrder.findFirst({
          where: { shop, lineItems: { some: { inventoryItemId: cleanItemId } } },
          orderBy: { createdAt: 'desc' },
          include: { supplier: true }
        });

        // Fall back to first available supplier
        const supplier = lastPO?.supplier || await prisma.supplier.findFirst({ where: { shop } });
        if (!supplier) continue;

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
            supplierId: supplier.id,
            createdBy: 'System (Forecast Reorder)',
            notes: `Auto-generated: Forecast shows ${product.productName} needs ${product.suggestedQty} units (${product.daysUntilStockout ?? 0}d until stockout)`,
            totalUnits: product.suggestedQty!,
            totalCost: 0,
            lineItems: {
              create: [{
                inventoryItemId: cleanItemId,
                productName: product.productName,
                sku: product.sku || '',
                orderedQty: product.suggestedQty!,
                unitCost: 0
              }]
            }
          }
        });
        createdPOs.push({
          poNumber,
          productName: product.productName,
          qty: product.suggestedQty!,
          supplier: supplier.name,
          daysLeft: product.daysUntilStockout
        });
        console.log(`[Forecast AutoPO] Created draft PO ${poNumber} for ${product.productName} (${product.suggestedQty} units)`);
      }

      // Send summary email notification for all created POs
      if (createdPOs.length > 0 && config.poAlertEmails) {
        const recipients = config.poAlertEmails.split(',').map(e => e.trim()).filter(e => e);
        if (recipients.length > 0) {
          try {
            const { Resend } = await import("resend");
            const resend = new Resend(process.env.RESEND_API_KEY || "re_12345");

            const poRows = createdPOs.map(po =>
              `<tr>
                <td style="padding:8px;border-bottom:1px solid #eee"><strong>${po.poNumber}</strong></td>
                <td style="padding:8px;border-bottom:1px solid #eee">${po.productName}</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${po.qty} units</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${po.supplier}</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${po.daysLeft !== null ? po.daysLeft + 'd left' : '—'}</td>
              </tr>`
            ).join('');

            await resend.emails.send({
              from: "Purchase Orders <onboarding@resend.dev>",
              to: recipients,
              subject: `📦 ${createdPOs.length} Draft PO(s) Created — Review Required [${shop}]`,
              html: `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
                  <h2 style="color:#1a1a1a">📦 Auto-Generated Purchase Orders</h2>
                  <p style="color:#666">The demand forecast engine has created <strong>${createdPOs.length} draft PO(s)</strong> that need your review and approval.</p>
                  <table style="width:100%;border-collapse:collapse;margin:16px 0">
                    <tr style="background:#f5f5f5">
                      <th style="padding:8px;text-align:left">PO #</th>
                      <th style="padding:8px;text-align:left">Product</th>
                      <th style="padding:8px;text-align:left">Qty</th>
                      <th style="padding:8px;text-align:left">Supplier</th>
                      <th style="padding:8px;text-align:left">Stock Left</th>
                    </tr>
                    ${poRows}
                  </table>
                  <p style="color:#666">Log into <strong>Shopify Protection</strong> → <strong>Purchase Orders</strong> to review, adjust quantities, and approve these drafts.</p>
                  <p style="color:#999;font-size:12px">Store: ${shop} · Generated: ${new Date().toLocaleString()}</p>
                </div>
              `
            });
            console.log(`[Forecast AutoPO] Sent notification email to ${recipients.length} recipient(s)`);
          } catch (emailErr) {
            console.error('[Forecast AutoPO] Failed to send notification email:', emailErr);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Forecast] Failed to auto-generate POs:', err);
  }

  console.log(`[Forecast] Calculated forecasts for ${results.length} products`);
  return results;
}
