import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page, Layout, Card, BlockStack, Text, IndexTable, Badge, Button, Banner,
  InlineStack, TextField, Tooltip, Box, Modal, FormLayout, Divider
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runForecast } from "../services/forecast.server";
import { useState, useCallback } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const forecasts = await prisma.demandForecast.findMany({
    where: { shop },
    orderBy: { daysUntilStockout: 'asc' }
  });

  const reorderConfigs = await prisma.reorderConfig.findMany({ where: { shop } });
  const globalConfig = reorderConfigs.find(c => c.inventoryItemId === "__GLOBAL__");

  // Build per-product config map
  const productConfigs: Record<string, { leadTimeDays: number; safetyStockDays: number }> = {};
  reorderConfigs.forEach(c => {
    if (c.inventoryItemId !== "__GLOBAL__") {
      productConfigs[c.inventoryItemId] = { leadTimeDays: c.leadTimeDays, safetyStockDays: c.safetyStockDays };
    }
  });

  // Check if suppliers exist (for Create PO button)
  const supplierCount = await prisma.supplier.count({ where: { shop } });

  return json({
    forecasts,
    globalLeadTime: globalConfig?.leadTimeDays ?? 14,
    globalSafetyDays: globalConfig?.safetyStockDays ?? 7,
    lastCalculated: forecasts.length > 0 ? forecasts[0].calculatedAt : null,
    productConfigs,
    hasSuppliers: supplierCount > 0
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "refreshForecast") {
    const results = await runForecast(shop, admin);
    return json({ success: true, count: results.length });
  }

  if (actionType === "updateGlobalConfig") {
    const leadTime = parseInt(formData.get("leadTimeDays") as string, 10) || 14;
    const safetyDays = parseInt(formData.get("safetyStockDays") as string, 10) || 7;

    await prisma.reorderConfig.upsert({
      where: { shop_inventoryItemId: { shop, inventoryItemId: "__GLOBAL__" } },
      update: { leadTimeDays: leadTime, safetyStockDays: safetyDays },
      create: { shop, inventoryItemId: "__GLOBAL__", leadTimeDays: leadTime, safetyStockDays: safetyDays }
    });

    const results = await runForecast(shop, admin);
    return json({ success: true, count: results.length });
  }

  if (actionType === "updateProductConfig") {
    const inventoryItemId = formData.get("inventoryItemId") as string;
    const leadTimeDays = parseInt(formData.get("leadTimeDays") as string, 10);
    const safetyStockDays = parseInt(formData.get("safetyStockDays") as string, 10);
    const useManualMinimum = formData.get("useManualMinimum") === "true";
    const manualMinimumRaw = formData.get("manualMinimum") as string;
    const manualMinimum = manualMinimumRaw ? parseInt(manualMinimumRaw, 10) : null;

    await prisma.reorderConfig.upsert({
      where: { shop_inventoryItemId: { shop, inventoryItemId } },
      update: { leadTimeDays, safetyStockDays, useManualMinimum, manualMinimum },
      create: { shop, inventoryItemId, leadTimeDays, safetyStockDays, useManualMinimum, manualMinimum }
    });
    return json({ success: true });
  }

  if (actionType === "createDraftPO") {
    const productName = formData.get("productName") as string;
    const inventoryItemId = formData.get("inventoryItemId") as string;
    const suggestedQty = parseInt(formData.get("suggestedQty") as string, 10) || 1;
    const sku = formData.get("sku") as string || '';

    // Find the last supplier for this product
    const lastPO = await prisma.purchaseOrder.findFirst({
      where: { shop, lineItems: { some: { inventoryItemId } } },
      orderBy: { createdAt: 'desc' },
      include: { supplier: true }
    });

    // Fall back to first available supplier
    const supplier = lastPO?.supplier || await prisma.supplier.findFirst({ where: { shop } });

    if (!supplier) {
      return json({ error: "No suppliers configured. Add a supplier first." }, { status: 400 });
    }

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
        notes: `Auto-generated from demand forecast for ${productName}`,
        totalUnits: suggestedQty,
        totalCost: 0,
        lineItems: {
          create: [{
            inventoryItemId,
            productName,
            sku,
            orderedQty: suggestedQty,
            unitCost: 0
          }]
        }
      }
    });

    return json({ success: true, poNumber });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

function StockHealthBadge({ daysUntilStockout, reorderPoint, currentStock }: {
  daysUntilStockout: number | null;
  reorderPoint: number | null;
  currentStock: number;
}) {
  if (currentStock === 0) return <Badge tone="critical">OUT OF STOCK</Badge>;
  if (daysUntilStockout !== null && daysUntilStockout <= 7) return <Badge tone="critical">Critical — {daysUntilStockout}d left</Badge>;
  if (daysUntilStockout !== null && daysUntilStockout <= 14) return <Badge tone="warning">Low — {daysUntilStockout}d left</Badge>;
  if (reorderPoint !== null && currentStock <= reorderPoint) return <Badge tone="warning">Below Reorder Point</Badge>;
  if (daysUntilStockout !== null && daysUntilStockout <= 30) return <Badge tone="attention">Monitor — {daysUntilStockout}d left</Badge>;
  return <Badge tone="success">Healthy</Badge>;
}

function TrendBadge({ direction, rate }: { direction: string; rate: number }) {
  if (direction === "rising") return <Badge tone="success">↑ +{rate}%/wk</Badge>;
  if (direction === "declining") return <Badge tone="warning">↓ {rate}%/wk</Badge>;
  return <Badge tone="info">→ Stable</Badge>;
}

export default function ForecastDashboard() {
  const { forecasts, globalLeadTime, globalSafetyDays, lastCalculated, productConfigs, hasSuppliers } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const [leadTime, setLeadTime] = useState(globalLeadTime.toString());
  const [safetyDays, setSafetyDays] = useState(globalSafetyDays.toString());

  // Product detail modal state
  const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
  const [productLeadTime, setProductLeadTime] = useState("");
  const [productSafetyDays, setProductSafetyDays] = useState("");
  const [useManualMinimum, setUseManualMinimum] = useState(false);
  const [manualMinimum, setManualMinimum] = useState("");
  const [poCreated, setPoCreated] = useState<string | null>(null);

  const openProductDetail = useCallback((f: any) => {
    setSelectedProduct(f);
    const config = productConfigs[f.inventoryItemId];
    setProductLeadTime(config?.leadTimeDays?.toString() || globalLeadTime.toString());
    setProductSafetyDays(config?.safetyStockDays?.toString() || globalSafetyDays.toString());
    setUseManualMinimum(config?.useManualMinimum || false);
    setManualMinimum(config?.manualMinimum?.toString() || "");
    setPoCreated(null);
  }, [productConfigs, globalLeadTime, globalSafetyDays]);

  const handleRefresh = () => submit({ actionType: "refreshForecast" }, { method: "post" });

  const handleSaveConfig = () => {
    submit({ actionType: "updateGlobalConfig", leadTimeDays: leadTime, safetyStockDays: safetyDays }, { method: "post" });
  };

  const handleSaveProductConfig = () => {
    if (!selectedProduct) return;
    submit({
      actionType: "updateProductConfig",
      inventoryItemId: selectedProduct.inventoryItemId,
      leadTimeDays: productLeadTime,
      safetyStockDays: productSafetyDays,
      useManualMinimum: useManualMinimum ? "true" : "false",
      manualMinimum: manualMinimum
    }, { method: "post" });
  };

  const handleCreatePO = useCallback((f: any) => {
    submit({
      actionType: "createDraftPO",
      productName: f.productName,
      inventoryItemId: f.inventoryItemId,
      suggestedQty: (f.suggestedQty || 1).toString(),
      sku: f.sku || ''
    }, { method: "post" });
    setPoCreated(f.productName);
  }, [submit]);

  // Summary stats
  const outOfStock = forecasts.filter((f: any) => f.currentStock === 0).length;
  const critical = forecasts.filter((f: any) => f.daysUntilStockout !== null && f.daysUntilStockout > 0 && f.daysUntilStockout <= 7).length;
  const needsReorder = forecasts.filter((f: any) => f.suggestedQty !== null && f.suggestedQty > 0).length;

  const resourceName = { singular: 'product', plural: 'products' };

  const p = selectedProduct;

  return (
    <Page
      title="📈 Demand Forecast"
      subtitle={lastCalculated ? `Last calculated: ${new Date(lastCalculated).toLocaleString()}` : "No forecast data yet"}
      primaryAction={{
        content: isLoading ? "Calculating..." : "Refresh Forecast",
        onAction: handleRefresh,
        loading: isLoading,
      }}
    >
      <Layout>
        {/* Summary Cards */}
        <Layout.Section>
          <InlineStack gap="400" wrap={true}>
            <div style={{ flex: 1, minWidth: '200px' }}>
              <Card padding="400"><BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Products Tracked</Text>
                <Text as="p" variant="headingXl">{forecasts.length}</Text>
              </BlockStack></Card>
            </div>
            <div style={{ flex: 1, minWidth: '200px' }}>
              <Card padding="400"><BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Out of Stock</Text>
                <Text as="p" variant="headingXl" tone={outOfStock > 0 ? "critical" : undefined}>{outOfStock}</Text>
              </BlockStack></Card>
            </div>
            <div style={{ flex: 1, minWidth: '200px' }}>
              <Card padding="400"><BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Critical (≤7 days)</Text>
                <Text as="p" variant="headingXl" tone={critical > 0 ? "critical" : undefined}>{critical}</Text>
              </BlockStack></Card>
            </div>
            <div style={{ flex: 1, minWidth: '200px' }}>
              <Card padding="400"><BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Needs Reorder</Text>
                <Text as="p" variant="headingXl" tone={needsReorder > 0 ? "caution" : undefined}>{needsReorder}</Text>
              </BlockStack></Card>
            </div>
          </InlineStack>
        </Layout.Section>

        {/* Global Configuration */}
        <Layout.Section>
          <Card padding="400">
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Reorder Configuration (Global Defaults)</Text>
              <InlineStack gap="400" align="start">
                <div style={{ width: '200px' }}>
                  <TextField label="Supplier Lead Time" type="number" value={leadTime} onChange={setLeadTime} suffix="days" autoComplete="off" helpText="How long it takes your supplier to deliver" />
                </div>
                <div style={{ width: '200px' }}>
                  <TextField label="Safety Stock Buffer" type="number" value={safetyDays} onChange={setSafetyDays} suffix="days" autoComplete="off" helpText="Extra days of stock to keep as a buffer" />
                </div>
                <div style={{ paddingTop: '24px' }}>
                  <Button onClick={handleSaveConfig} variant="primary" loading={isLoading}>Save & Recalculate</Button>
                </div>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Forecast Table */}
        <Layout.Section>
          <Card padding="0">
            {forecasts.length === 0 ? (
              <Box padding="400">
                <Banner tone="info">
                  <p>No forecast data yet. Click <strong>"Refresh Forecast"</strong> to analyze your sales history and generate demand predictions.</p>
                </Banner>
              </Box>
            ) : (
              <IndexTable
                resourceName={resourceName}
                itemCount={forecasts.length}
                headings={[
                  { title: 'Product' }, { title: 'Stock' }, { title: 'Health' },
                  { title: 'Avg/Day' }, { title: 'Trend' },
                  { title: '30d' }, { title: '60d' }, { title: '90d' },
                  { title: 'Reorder Pt' }, { title: 'Action' },
                ]}
                selectable={false}
              >
                {forecasts.map((f: any, index: number) => (
                  <IndexTable.Row id={f.id} key={f.id} position={index} onClick={() => openProductDetail(f)}>
                    <IndexTable.Cell>
                      <Tooltip content={f.sku ? `SKU: ${f.sku}` : 'Click for details'}>
                        <div style={{ maxWidth: '180px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <Text as="span" variant="bodyMd" fontWeight="bold">{f.productName}</Text>
                        </div>
                      </Tooltip>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="bold" tone={f.currentStock === 0 ? "critical" : undefined}>{f.currentStock}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <StockHealthBadge daysUntilStockout={f.daysUntilStockout} reorderPoint={f.reorderPoint} currentStock={f.currentStock} />
                    </IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodyMd">{f.avgDailySales}</Text></IndexTable.Cell>
                    <IndexTable.Cell><TrendBadge direction={f.trendDirection} rate={f.trendRate} /></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodyMd">{f.forecast30d}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodyMd">{f.forecast60d}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodyMd">{f.forecast90d}</Text></IndexTable.Cell>
                    <IndexTable.Cell>
                      {f.reorderPoint !== null ? (
                        <Text as="span" variant="bodyMd">{f.reorderPoint}</Text>
                      ) : (<Text as="span" variant="bodySm" tone="subdued">—</Text>)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {f.suggestedQty !== null && f.suggestedQty > 0 ? (
                        <Button size="slim" onClick={(e) => { e?.stopPropagation?.(); handleCreatePO(f); }} disabled={!hasSuppliers}>
                          📦 Order {f.suggestedQty}
                        </Button>
                      ) : (
                        <Text as="span" variant="bodySm" tone="subdued">—</Text>
                      )}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>

        {/* PO Creation feedback */}
        {poCreated && (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => setPoCreated(null)}>
              <p>Draft PO created for <strong>{poCreated}</strong>. <a href="/app/purchase-orders">View Purchase Orders →</a></p>
            </Banner>
          </Layout.Section>
        )}

        {/* Info */}
        <Layout.Section>
          <Card padding="400">
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">How Forecasting Works</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                The forecast engine analyzes your last 90 days of Shopify order data to calculate:
              </Text>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm">📊 <strong>Average Daily Sales</strong> — 30-day rolling average of units sold per day</Text>
                <Text as="p" variant="bodySm">📈 <strong>Trend</strong> — Linear regression on weekly totals to detect rising, stable, or declining demand</Text>
                <Text as="p" variant="bodySm">📅 <strong>Seasonality</strong> — Day-of-week adjustment (some products sell more on weekends)</Text>
                <Text as="p" variant="bodySm">🎯 <strong>Reorder Point</strong> — (Lead Time + Safety Stock) × Daily Sales Rate</Text>
                <Text as="p" variant="bodySm">📦 <strong>Suggested Order</strong> — How much to order to cover lead time + safety + 30 days of buffer</Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* Product Detail Modal */}
      <Modal
        open={!!selectedProduct}
        onClose={() => setSelectedProduct(null)}
        title={p ? `📊 ${p.productName}` : "Product Detail"}
        large
      >
        {p && (
          <Modal.Section>
            <BlockStack gap="400">
              {/* Key Metrics */}
              <InlineStack gap="400" wrap>
                <div style={{ flex: 1, minWidth: '120px' }}>
                  <Card padding="300"><BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Current Stock</Text>
                    <Text as="p" variant="headingLg" fontWeight="bold" tone={p.currentStock === 0 ? "critical" : undefined}>{p.currentStock}</Text>
                  </BlockStack></Card>
                </div>
                <div style={{ flex: 1, minWidth: '120px' }}>
                  <Card padding="300"><BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Avg Daily Sales</Text>
                    <Text as="p" variant="headingLg" fontWeight="bold">{p.avgDailySales}</Text>
                  </BlockStack></Card>
                </div>
                <div style={{ flex: 1, minWidth: '120px' }}>
                  <Card padding="300"><BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Days Until Stockout</Text>
                    <Text as="p" variant="headingLg" fontWeight="bold" tone={p.daysUntilStockout && p.daysUntilStockout <= 14 ? "critical" : undefined}>
                      {p.daysUntilStockout !== null ? `${p.daysUntilStockout}d` : '∞'}
                    </Text>
                  </BlockStack></Card>
                </div>
                <div style={{ flex: 1, minWidth: '120px' }}>
                  <Card padding="300"><BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Reorder Point</Text>
                    <Text as="p" variant="headingLg" fontWeight="bold">{p.reorderPoint ?? '—'}</Text>
                  </BlockStack></Card>
                </div>
              </InlineStack>

              {/* Health & Trend */}
              <Card padding="300">
                <InlineStack gap="400" blockAlign="center">
                  <StockHealthBadge daysUntilStockout={p.daysUntilStockout} reorderPoint={p.reorderPoint} currentStock={p.currentStock} />
                  <TrendBadge direction={p.trendDirection} rate={p.trendRate} />
                  {p.sku && <Badge>{`SKU: ${p.sku}`}</Badge>}
                </InlineStack>
              </Card>

              {/* Demand Projections */}
              <Card padding="300">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">Demand Projections</Text>
                  <InlineStack gap="400" wrap>
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">30-Day</Text>
                      <Text as="p" variant="headingMd">{p.forecast30d} units</Text>
                    </BlockStack>
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">60-Day</Text>
                      <Text as="p" variant="headingMd">{p.forecast60d} units</Text>
                    </BlockStack>
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">90-Day</Text>
                      <Text as="p" variant="headingMd">{p.forecast90d} units</Text>
                    </BlockStack>
                  </InlineStack>

                  {p.trendDirection !== 'stable' && (
                    <Banner tone={p.trendDirection === 'rising' ? 'success' : 'warning'}>
                      <p>
                        {p.trendDirection === 'rising'
                          ? `Demand is increasing at ${p.trendRate}%/week. Consider stocking ahead of the curve.`
                          : `Demand is declining at ${p.trendRate}%/week. You may want to reduce next order quantities.`
                        }
                      </p>
                    </Banner>
                  )}

                  {/* Seasonality */}
                  <Text as="h3" variant="headingSm">Weekly Pattern</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Day-of-week seasonality index (1.0 = average). Higher values indicate stronger sales days.
                  </Text>
                  <InlineStack gap="200" wrap>
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => {
                      const idx = p.seasonalityIndex ? JSON.parse(p.seasonalityIndex) : null;
                      const val = idx ? idx[i] : 1.0;
                      return (
                        <div key={day} style={{ textAlign: 'center', minWidth: '50px' }}>
                          <Text as="p" variant="bodySm" tone="subdued">{day}</Text>
                          <Text as="p" variant="bodyMd" fontWeight="bold" tone={val > 1.2 ? 'success' : val < 0.8 ? 'critical' : undefined}>
                            {typeof val === 'number' ? val.toFixed(2) : '1.00'}
                          </Text>
                        </div>
                      );
                    })}
                  </InlineStack>
                </BlockStack>
              </Card>

              <Divider />

              {/* Per-Product Reorder Config */}
              {/* Per-Product Reorder Config */}
              <Card padding="400">
                <BlockStack gap="400">
                  <Text as="h3" variant="headingMd">📊 Reorder Strategy & Statistical Variance</Text>
                  
                  <BlockStack gap="200">
                    <Text as="h4" variant="headingSm">Why Automated Forecasting Replaces Manual Limits</Text>
                    <Text as="p" variant="bodyMd">
                      Manual limits force you to guess. Our engine applies a <strong>Two Sigma (2σ)</strong> statistical variance model to your sales history, adapting to both <em>velocity</em> and <em>volatility</em>.
                    </Text>
                  </BlockStack>

                  <BlockStack gap="200">
                    <Text as="h4" variant="headingSm">The Algorithmic Approach (Two Sigma Engine)</Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      <strong>Base Demand:</strong> Average Daily Sales × Supplier Lead Time<br/>
                      <strong>Dynamic Safety Stock (+2σ):</strong> By adding a 2-Sigma standard deviation buffer, we mathematically guarantee you have enough stock to absorb 95.4% of unexpected demand spikes during your lead time.
                    </Text>
                  </BlockStack>

                  <BlockStack gap="200">
                    <Checkbox
                      label="Enforce a Manual Minimum Floor (Optional)"
                      checked={useManualMinimum}
                      onChange={setUseManualMinimum}
                      helpText="If checked, the system will use the HIGHER of either the Statistical Forecast or this Hard Minimum."
                    />
                  </BlockStack>

                  <InlineStack gap="400" align="start">
                    <div style={{ width: '180px' }}>
                      <TextField label="Lead Time" type="number" value={productLeadTime} onChange={setProductLeadTime} suffix="days" autoComplete="off" />
                    </div>
                    <div style={{ width: '180px' }}>
                      <TextField label="Safety Buffer" type="number" disabled value="Auto (+2σ)" onChange={() => {}} autoComplete="off" helpText="Calculated via standard deviation" />
                    </div>
                    {useManualMinimum && (
                      <div style={{ width: '180px' }}>
                        <TextField label="Minimum Floor" type="number" value={manualMinimum} onChange={setManualMinimum} suffix="units" autoComplete="off" helpText="Overrides forecast if higher" />
                      </div>
                    )}
                    <div style={{ paddingTop: '24px' }}>
                      <Button onClick={handleSaveProductConfig} loading={isLoading}>Save Configuration</Button>
                    </div>
                  </InlineStack>

                  {productConfigs[p.inventoryItemId] && (
                    <Badge tone="info">Custom config active</Badge>
                  )}
                </BlockStack>
              </Card>

              {/* Create PO Action */}
              {p.suggestedQty !== null && p.suggestedQty > 0 && (
                <Card padding="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">📦 Reorder Recommended</Text>
                      <Text as="p" variant="bodySm">Suggested order: <strong>{p.suggestedQty} units</strong> to cover lead time + safety + 30 days</Text>
                    </BlockStack>
                    <Button variant="primary" onClick={() => handleCreatePO(p)} disabled={!hasSuppliers}>
                      Create Draft PO
                    </Button>
                  </InlineStack>
                  {!hasSuppliers && (
                    <Text as="p" variant="bodySm" tone="critical">Add a supplier in Purchase Orders first.</Text>
                  )}
                </Card>
              )}
            </BlockStack>
          </Modal.Section>
        )}
      </Modal>
    </Page>
  );
}
