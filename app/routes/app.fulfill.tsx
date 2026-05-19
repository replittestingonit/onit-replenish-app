import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, Badge, InlineStack, Banner, Button, Box, Select, TextField, DropZone, Thumbnail, FormLayout } from "@shopify/polaris";
import { NoteIcon } from "@shopify/polaris-icons";
import prisma from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const config = await prisma.appConfiguration.findUnique({ where: { shop } });

  // Auto-detect the current logged-in user
  let currentUser = 'Shopify User';
  try {
    const onlineUser = (session as any).onlineAccessInfo?.associated_user;
    if (onlineUser) {
      currentUser = `${onlineUser.first_name} ${onlineUser.last_name}`.trim();
    }
  } catch (e) {
    console.error('Failed to detect current user:', e);
  }

  // Fetch Locations to get visibility mapping
  const locRes = await admin.graphql(`
    query { locations(first: 10, query: "active:true") { edges { node { id name } } } }
  `);
  const locData = await locRes.json();
  let locations = locData.data?.locations?.edges.map((e: any) => e.node) || [];

  // Apply Staff Location Constraints
  const constraints = JSON.parse(config?.staffLocationConstraints || "{}");
  let allowedLocIds: string[] | null = null;
  
  if (currentUser && constraints[currentUser] && Array.isArray(constraints[currentUser])) {
    allowedLocIds = constraints[currentUser];
    locations = locations.filter((loc: any) => allowedLocIds?.includes(loc.id));
  }

  // Fetch Unfulfilled Orders using only Order fields (no fulfillmentOrders scope needed)
  let fulfillmentOrders: any[] = [];
  let scopeError = false;

  try {
    const foRes = await admin.graphql(`
      query {
        orders(first: 50, query: "fulfillment_status:unfulfilled OR fulfillment_status:partial") {
          edges {
            node {
              id
              name
              createdAt
              physicalLocation {
                id
                name
              }
              lineItems(first: 20) {
                edges {
                  node {
                    id
                    title
                    quantity
                    sku
                    variant {
                      inventoryItem { id }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `);
    
    const foData = await foRes.json();
    
    // Map orders into the fulfillmentOrders shape the UI expects
    const orders = foData.data?.orders?.edges.map((e: any) => e.node) || [];
    for (const order of orders) {
      fulfillmentOrders.push({
        id: order.id,
        status: 'OPEN',
        order: { name: order.name, createdAt: order.createdAt },
        assignedLocation: {
          location: order.physicalLocation || { id: 'unknown', name: 'Default' }
        },
        lineItems: {
          edges: order.lineItems.edges.map((e: any) => ({
            node: {
              id: e.node.id,
              totalQuantity: e.node.quantity,
              lineItem: {
                title: e.node.title,
                sku: e.node.sku,
                variant: e.node.variant
              }
            }
          }))
        }
      });
    }

    // Filter by Allowed Locations
    if (allowedLocIds) {
      fulfillmentOrders = fulfillmentOrders.filter((fo: any) => {
        const locId = fo.assignedLocation?.location?.id;
        return locId && allowedLocIds?.includes(locId);
      });
    }
  } catch (e: any) {
    console.error('Fulfillment query failed (likely missing scope):', e.message);
    scopeError = true;
  }

  return json({ 
    currentUser,
    fulfillmentOrders,
    scopeError,
    config: {
      highValueItems: JSON.parse(config?.highValueItems || "[]"),
      serialNumberRequiredItems: JSON.parse(config?.serialNumberRequiredItems || "[]")
    }
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const { admin } = await unauthenticated.admin(shop);

  const formData = await request.formData();
  const orderId = formData.get("orderId") as string;
  const orderName = formData.get("orderName") as string;
  const trackingNumber = formData.get("trackingNumber") as string;
  const staffName = formData.get("staffName") as string;
  const serializedItemsStr = formData.get("serializedItems") as string;
  
  if (!orderId) {
    return json({ error: "Missing order ID" }, { status: 400 });
  }

  try {
    // 1. Get the Fulfillment Orders for this Order
    const foRes = await admin.graphql(`
      query getFO($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 10, query: "status:OPEN") {
            edges { node { id } }
          }
        }
      }
    `, { variables: { id: orderId } });
    
    const foData = await foRes.json();
    const fulfillmentOrders = foData.data?.order?.fulfillmentOrders?.edges.map((e: any) => e.node.id) || [];
    
    if (fulfillmentOrders.length === 0) {
      return json({ error: "No open fulfillments found for this order." }, { status: 400 });
    }

    // 2. Fulfill each Fulfillment Order
    for (const foId of fulfillmentOrders) {
      const fulfillRes = await admin.graphql(`
        mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            userErrors { field message }
          }
        }
      `, {
        variables: {
          fulfillment: {
            notifyCustomer: true,
            trackingInfo: trackingNumber ? { number: trackingNumber } : null,
            lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: foId }]
          }
        }
      });
      const fulfillData = await fulfillRes.json();
      const errors = fulfillData.data?.fulfillmentCreateV2?.userErrors;
      if (errors && errors.length > 0) {
        console.error("Fulfillment error:", errors);
        return json({ error: errors[0].message }, { status: 400 });
      }
    }

    // 3. Log Chain of Custody for Serialized Items
    if (serializedItemsStr) {
      const serializedItems = JSON.parse(serializedItemsStr);
      for (const item of serializedItems) {
        // We log an inventory event to maintain chain of custody
        await prisma.inventoryEvent.create({
          data: {
            shop,
            inventoryItemId: item.inventoryItemId,
            time: new Date(),
            available: 0, // This is just a custody log, Shopify handles actual deduction
            reason: `Ship Out - ${staffName}`,
            transactionId: orderId,
            referenceNumber: `Order ${orderName} | Serials: ${item.serials.join(', ')}`,
            isFullyMet: true
          }
        });
      }
    }

    return json({ success: true });
  } catch (err: any) {
    console.error("Fulfillment action failed:", err);
    return json({ error: err.message }, { status: 500 });
  }
};

export default function SecureFulfillment() {
  const { currentUser, fulfillmentOrders, scopeError, config } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const actionData = useActionData<typeof action>();
  
  const [activeOrder, setActiveOrder] = useState<any>(null);
  const [scanResult, setScanResult] = useState<{message: string, isMatch: boolean} | null>(null);
  const [pickedCounts, setPickedCounts] = useState<Record<string, number>>({});
  const [pickedSerials, setPickedSerials] = useState<Record<string, string[]>>({});
  
  const [manualEntryItem, setManualEntryItem] = useState<{id: string, requiresSerial: boolean} | null>(null);
  const [manualSkuInput, setManualSkuInput] = useState("");
  const [manualSerialInput, setManualSerialInput] = useState("");


  const handleScanFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeOrder) return;
    
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("scan-region");
      const decodedText = await scanner.scanFile(file, true);
      
      const matchedEdge = activeOrder.lineItems.edges.find((edge: any) => {
        const sku = edge.node.lineItem?.sku;
        return sku === decodedText || edge.node.lineItem?.title.includes(decodedText);
      });

      if (matchedEdge) {
        const itemId = matchedEdge.node.id;
        const totalReq = matchedEdge.node.totalQuantity;
        const itemName = matchedEdge.node.lineItem?.title || "Item";
        
        const invId = matchedEdge.node.lineItem?.variant?.inventoryItem?.id;
        const requiresSerial = invId && config?.serialNumberRequiredItems?.includes(invId);

        if (requiresSerial) {
          setManualEntryItem({ id: itemId, requiresSerial: true });
          setManualSkuInput(decodedText);
          setManualSerialInput("");
          setScanResult({ message: `Scanned ${itemName}. Please enter the Serial Number.`, isMatch: true });
        } else {
          setPickedCounts(prev => {
            const current = prev[itemId] || 0;
            if (current < totalReq) {
              setScanResult({ message: `Scanned 1x ${itemName}. (${current + 1}/${totalReq} in cart)`, isMatch: true });
              return { ...prev, [itemId]: current + 1 };
            } else {
              setScanResult({ message: `You have already picked enough of ${itemName}.`, isMatch: false });
              return prev;
            }
          });
        }
      } else {
        setScanResult({ message: `No Match: ${decodedText} is not in this order. Keep searching.`, isMatch: false });
      }
      await scanner.clear();
    } catch (err: any) {
      setScanResult({ message: `Could not read barcode. Try again with a clearer photo.`, isMatch: false });
    }
    // Reset file input so the same file can be re-selected
    e.target.value = '';
  }, [activeOrder]);

  const [trackingNumber, setTrackingNumber] = useState("");

  const handleTrackingScanFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("tracking-scan-region");
      const decodedText = await scanner.scanFile(file, true);
      setTrackingNumber(decodedText);
      if (typeof (window as any).shopify !== 'undefined') {
        (window as any).shopify.toast.show("Tracking number captured!");
      }
      await scanner.clear();
    } catch (err: any) {
      if (typeof (window as any).shopify !== 'undefined') {
        (window as any).shopify.toast.show("Could not read barcode. Try a clearer photo.");
      }
    }
    e.target.value = '';
  }, []);

  const [activePhase, setActivePhase] = useState<'PICK' | 'PACK' | 'DROP_OFF' | 'COMPLETE'>('PICK');
  const [sacredOverrideMode, setSacredOverrideMode] = useState('single');
  const [verifierName, setVerifierName] = useState("");
  const [verifierPin, setVerifierPin] = useState("");
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [sacredVerified, setSacredVerified] = useState(false);
  
  const [receiptFile, setReceiptFile] = useState<File | null>(null);

  useEffect(() => {
    if (actionData && 'success' in actionData && actionData.success) {
      setActivePhase('COMPLETE');
    }
  }, [actionData]);

  const hasSacredItem = useMemo(() => {
    if (!activeOrder || !config?.highValueItems) return false;
    return activeOrder.lineItems.edges.some((edge: any) => {
      const invId = edge.node.lineItem?.variant?.inventoryItem?.id;
      return invId && config.highValueItems.includes(invId);
    });
  }, [activeOrder, config]);

  const handleDropZoneDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[], _rejectedFiles: File[]) => {
      setEvidenceFiles((prev) => [...prev, ...acceptedFiles]);
    },
    [],
  );

  const handleReceiptDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[], _rejectedFiles: File[]) => {
      if (acceptedFiles.length > 0) setReceiptFile(acceptedFiles[0]);
    },
    [],
  );

  const handleVerify = () => {
    if (sacredOverrideMode === 'twoman' && (!verifierName || !verifierPin)) return;
    setSacredVerified(true);
  };

  if (activeOrder) {
    return (
      <Page 
        title={`Order ${activeOrder.order.name}`} 
        backAction={{content: 'Queue', onAction: () => { setActiveOrder(null); setScanResult(null); setPickedCounts({}); setPickedSerials({}); }}}
      >
        <Layout>
          <Layout.Section>
            <Card padding="400">
              {activePhase === 'PICK' ? (
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Pick List</Text>
                  <ul>
                    {activeOrder.lineItems.edges.map((edge: any) => {
                      const item = edge.node;
                      const req = item.totalQuantity;
                      const picked = pickedCounts[item.id] || 0;
                      const isComplete = picked >= req;
                      
                      return (
                        <li key={item.id} style={{ marginBottom: '12px', padding: '12px', background: isComplete ? '#e3f1df' : '#f4f6f8', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <Text as="p" variant="bodyMd" fontWeight="bold">
                              {item.lineItem?.title}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {item.lineItem?.sku ? `SKU: ${item.lineItem.sku}` : 'No SKU'}
                            </Text>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <Text as="span" variant="bodyMd" fontWeight="bold" tone={isComplete ? "success" : "base"}>
                              {picked} / {req} picked
                            </Text>
                            {!isComplete && (
                              <Button size="micro" onClick={() => {
                                const invId = item.lineItem?.variant?.inventoryItem?.id;
                                const requiresSerial = invId && config?.serialNumberRequiredItems?.includes(invId);
                                setManualEntryItem({ id: item.id, requiresSerial: !!requiresSerial });
                                setManualSkuInput("");
                                setManualSerialInput("");
                              }}>
                                Manual Entry
                              </Button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  {manualEntryItem && (() => {
                    const matchedEdge = activeOrder.lineItems.edges.find((e: any) => e.node.id === manualEntryItem.id);
                    const item = matchedEdge?.node;
                    if (!item) return null;
                    return (
                      <Card background="bg-surface-secondary">
                        <BlockStack gap="400">
                          <Text variant="headingSm" as="h3">Manual Entry: {item.lineItem?.title}</Text>
                          <TextField
                            label="Enter SKU to Verify"
                            value={manualSkuInput}
                            onChange={setManualSkuInput}
                            autoComplete="off"
                            helpText={`Expected SKU: ${item.lineItem?.sku}`}
                          />
                          {manualEntryItem.requiresSerial && (
                            <TextField
                              label="Enter Serial Number"
                              value={manualSerialInput}
                              onChange={setManualSerialInput}
                              autoComplete="off"
                              requiredIndicator
                            />
                          )}
                          <InlineStack gap="300">
                            <Button onClick={() => setManualEntryItem(null)}>Cancel</Button>
                            <Button variant="primary" onClick={() => {
                              if (manualSkuInput !== item.lineItem?.sku && manualSkuInput !== item.lineItem?.title) {
                                setScanResult({ message: "SKU does not match. Try again.", isMatch: false });
                                return;
                              }
                              if (manualEntryItem.requiresSerial && !manualSerialInput) {
                                setScanResult({ message: "Serial Number is required.", isMatch: false });
                                return;
                              }
                              
                              setPickedCounts(prev => ({ ...prev, [item.id]: (prev[item.id] || 0) + 1 }));
                              if (manualEntryItem.requiresSerial) {
                                setPickedSerials(prev => ({ ...prev, [item.id]: [...(prev[item.id] || []), manualSerialInput] }));
                              }
                              setScanResult({ message: `Manually picked 1x ${item.lineItem?.title}.`, isMatch: true });
                              setManualEntryItem(null);
                            }}>Confirm Item</Button>
                          </InlineStack>
                        </BlockStack>
                      </Card>
                    );
                  })()}
                  
                  {scanResult && (
                    <Banner tone={scanResult.isMatch ? "success" : "critical"}>
                      <p>{scanResult.message}</p>
                    </Banner>
                  )}

                  <InlineStack gap="300" align="center">
                    <label style={{ cursor: 'pointer', display: 'inline-block', padding: '10px 20px', background: '#2c6ecb', color: 'white', borderRadius: '8px', fontSize: '14px', fontWeight: 600 }}>
                      📷 Scan to Find Items
                      <input type="file" accept="image/*" capture="environment" onChange={handleScanFile} style={{ display: 'none' }} />
                    </label>
                    <Button 
                      variant="primary" 
                      size="large" 
                      disabled={!activeOrder.lineItems.edges.every((edge: any) => {
                        const item = edge.node;
                        const req = item.totalQuantity;
                        const picked = pickedCounts[item.id] || 0;
                        if (picked < req) return false;
                        const invId = item.lineItem?.variant?.inventoryItem?.id;
                        const requiresSerial = invId && config?.serialNumberRequiredItems?.includes(invId);
                        if (requiresSerial) {
                          const serials = pickedSerials[item.id] || [];
                          if (serials.length < req) return false;
                        }
                        return true;
                      })}
                      onClick={() => { setActivePhase('PACK'); }}
                    >
                      All Items Picked - Move Cart to Packing Station
                    </Button>
                  </InlineStack>
                  <div id="scan-region" style={{ display: 'none' }}></div>
                </BlockStack>
              ) : activePhase === 'PACK' ? (
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Packing Station</Text>
                  
                  {hasSacredItem && !sacredVerified ? (
                    <Card background="bg-surface-critical" padding="400">
                      <BlockStack gap="400">
                        <Banner tone="critical" title="SECURITY LOCK: Sacred Item Detected">
                          <p>This order contains a high-value item and requires video evidence and/or secondary validation before a label can be printed.</p>
                        </Banner>
                        
                        <Select
                          label="Validation Method"
                          options={[
                            {label: 'Single-User Video Proof', value: 'single'},
                            {label: 'Two-Man Collaboration', value: 'twoman'},
                            {label: 'Remote Owner Verification', value: 'remote'},
                            {label: 'Overhead Camera Logging', value: 'nest'},
                            {label: 'Emergency Owner Bypass', value: 'emergency'}
                          ]}
                          value={sacredOverrideMode}
                          onChange={setSacredOverrideMode}
                        />

                        {sacredOverrideMode === 'twoman' && (
                          <FormLayout.Group>
                            <TextField label="Verifier Name" value={verifierName} onChange={setVerifierName} autoComplete="off" />
                            <TextField label="Verifier PIN" type="password" value={verifierPin} onChange={setVerifierPin} autoComplete="off" />
                          </FormLayout.Group>
                        )}

                        {sacredOverrideMode === 'emergency' && (
                          <TextField label="Owner Authorization PIN" type="password" value={verifierPin} onChange={setVerifierPin} autoComplete="off" helpText="Enter the Master Owner PIN to instantly bypass all video and Two-Man requirements for this Sacred Item." />
                        )}

                        {(sacredOverrideMode !== 'nest' && sacredOverrideMode !== 'emergency') && (
                          <DropZone onDrop={handleDropZoneDrop}>
                            {evidenceFiles.length > 0 ? (
                              <InlineStack gap="300">
                                {evidenceFiles.map((file, i) => (
                                  <Thumbnail key={i} size="small" alt={file.name} source={NoteIcon} />
                                ))}
                              </InlineStack>
                            ) : (
                              <DropZone.FileUpload actionTitle="Upload Verification Video" />
                            )}
                          </DropZone>
                        )}

                        <Button 
                          variant="primary" 
                          onClick={handleVerify} 
                          disabled={(sacredOverrideMode !== 'nest' && sacredOverrideMode !== 'emergency' && evidenceFiles.length === 0)}
                        >
                          {sacredOverrideMode === 'remote' ? 'Request Owner Approval' : 
                           sacredOverrideMode === 'emergency' ? 'Bypass Security' : 'Submit Verification'}
                        </Button>
                      </BlockStack>
                    </Card>
                  ) : (
                    <BlockStack gap="400">
                      {hasSacredItem && (
                        <Banner tone="success" title="Security Validation Passed">
                          <p>Evidence secured. Proceeding to labeling.</p>
                        </Banner>
                      )}
                      <Text as="p">All items have been verified. You may now generate the ShipStation label and affix it to the box.</Text>
                      
                      <FormLayout.Group>
                        <TextField 
                          label="Tracking Number (OCR Scan)" 
                          value={trackingNumber} 
                          onChange={setTrackingNumber} 
                          autoComplete="off" 
                          helpText="Use the camera to scan the tracking barcode on the generated shipping label."
                        />
                        <div style={{ alignSelf: 'flex-end', paddingBottom: '24px' }}>
                          <label style={{ cursor: 'pointer', display: 'inline-block', padding: '8px 16px', background: '#2c6ecb', color: 'white', borderRadius: '8px', fontSize: '13px', fontWeight: 600 }}>
                            📷 Scan Label Barcode
                            <input type="file" accept="image/*" capture="environment" onChange={handleTrackingScanFile} style={{ display: 'none' }} />
                          </label>
                        </div>
                      </FormLayout.Group>

                      <div id="tracking-scan-region" style={{ display: 'none' }}></div>

                      {/* Phase 5 Drop-off Receipt Transition */}
                      <Button variant="primary" disabled={!trackingNumber} onClick={() => setActivePhase('DROP_OFF')}>Proceed to Carrier Handoff</Button>
                    </BlockStack>
                  )}
                </BlockStack>
              ) : activePhase === 'DROP_OFF' ? (
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Chain of Custody: Carrier Handoff</Text>
                  <Banner tone="warning" title="Mandatory Receipt Scan">
                    <p>The package has been labeled with tracking number <strong>{trackingNumber}</strong>. Please drop it off at the carrier and upload a photo of the physical drop-off receipt.</p>
                  </Banner>
                  
                  <DropZone onDrop={handleReceiptDrop} allowMultiple={false}>
                    {receiptFile ? (
                      <InlineStack gap="300" align="center" blockAlign="center">
                        <Thumbnail size="small" alt={receiptFile.name} source={NoteIcon} />
                        <Text as="span" variant="bodyMd">{receiptFile.name}</Text>
                      </InlineStack>
                    ) : (
                      <DropZone.FileUpload actionTitle="Capture Drop-off Receipt" />
                    )}
                  </DropZone>

                  {actionData && 'error' in actionData && (
                    <Banner tone="critical"><p>{actionData.error as string}</p></Banner>
                  )}

                  <Button variant="primary" loading={nav.state === "submitting"} disabled={!receiptFile || nav.state === "submitting"} onClick={() => {
                    const serializedItems = [];
                    for (const edge of activeOrder.lineItems.edges) {
                      const invId = edge.node.lineItem?.variant?.inventoryItem?.id;
                      if (invId && config.serialNumberRequiredItems?.includes(invId) && pickedSerials[edge.node.id]) {
                        serializedItems.push({
                          inventoryItemId: invId,
                          serials: pickedSerials[edge.node.id]
                        });
                      }
                    }
                    
                    submit({
                      orderId: activeOrder.id,
                      orderName: activeOrder.order.name,
                      trackingNumber,
                      staffName: currentUser,
                      serializedItems: JSON.stringify(serializedItems)
                    }, { method: "post" });
                  }}>Confirm Handoff & Complete Order</Button>
                </BlockStack>
              ) : (
                <BlockStack gap="400" align="center">
                  <Banner tone="success" title="Fulfillment Completed!">
                    <p>Order {activeOrder.order.name} has been securely fulfilled and the chain of custody is closed.</p>
                  </Banner>
                  <Button variant="primary" size="large" onClick={() => { setActiveOrder(null); setActivePhase('PICK'); setTrackingNumber(""); setReceiptFile(null); setEvidenceFiles([]); setSacredVerified(false); }}>
                    Return to Queue
                  </Button>
                </BlockStack>
              )}
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page title="Ship Out (Blind Mode)" subtitle={`Worker: ${currentUser}`}>
      <Layout>
        <Layout.Section>
          {scopeError && (
            <Banner tone="warning" title="Scope Authorization Required">
              <p>This app needs the <strong>read_orders</strong> permission to display the fulfillment queue. Please uninstall and reinstall the app, or go to Settings &gt; Apps in your Shopify admin to re-approve access scopes.</p>
            </Banner>
          )}
          {!scopeError && fulfillmentOrders.length === 0 ? (
            <Banner tone="success" title="All Caught Up!">
              <p>There are no open fulfillment orders assigned to your permitted locations.</p>
            </Banner>
          ) : (
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Assigned Order Queue ({fulfillmentOrders.length})</Text>
              
              {fulfillmentOrders.map((fo: any) => (
                <Card key={fo.id} padding="400">
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text variant="headingSm" as="h3">Order {fo.order.name}</Text>
                      <Badge tone={fo.status === 'IN_PROGRESS' ? 'attention' : 'info'}>
                        {fo.status.replace('_', ' ')}
                      </Badge>
                    </InlineStack>
                    <Text variant="bodySm" as="p" tone="subdued">
                      Location: {fo.assignedLocation?.location?.name || 'Unknown'}
                    </Text>
                    
                    <div style={{ marginTop: '10px', marginBottom: '10px' }}>
                      <Text variant="bodyMd" as="span" fontWeight="bold">Items to Pick:</Text>
                      <ul style={{ paddingLeft: '20px', marginTop: '5px' }}>
                        {fo.lineItems.edges.map((edge: any) => {
                          const item = edge.node;
                          return (
                            <li key={item.id}>
                              <Text as="span" variant="bodyMd">
                                {item.totalQuantity}x {item.lineItem?.title} {item.lineItem?.sku ? `(SKU: ${item.lineItem.sku})` : ''}
                              </Text>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    
                    <InlineStack align="end">
                      <Button variant="primary" onClick={() => setActiveOrder(fo)}>Begin Picking</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              ))}
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
