/**
 * Alert Evidence Viewer — /app/alert/:id
 * 
 * When private evidence mode is enabled, alert emails link here instead
 * of including file links directly. The owner is already authenticated
 * via Shopify, so they can view evidence files inline.
 * 
 * This page resolves Shopify File IDs to viewable URLs and displays
 * them alongside the full alert details.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, Badge, InlineStack, Banner, Box, Divider } from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const alertId = params.id;

  if (!alertId) {
    return json({ error: "Missing alert ID", alert: null, files: [], event: null }, { status: 400 });
  }

  // Fetch the alert
  const alert = await prisma.triggeredAlert.findFirst({
    where: { id: alertId, shop },
    include: { rule: true }
  });

  if (!alert) {
    return json({ error: "Alert not found", alert: null, files: [], event: null }, { status: 404 });
  }

  // Find the associated inventory event (has the proof images)
  // The alert's transactionId contains the proof reference
  let event = null;
  let files: { id: string; url: string; alt: string; type: string; filename: string }[] = [];

  if (alert.transactionId) {
    // Try to find the event by proof image reference
    event = await prisma.inventoryEvent.findFirst({
      where: { shop, proofImage: alert.transactionId },
      orderBy: { time: 'desc' }
    });

    // Resolve Shopify File IDs to URLs
    try {
      const fileIds = JSON.parse(alert.transactionId);
      if (Array.isArray(fileIds) && fileIds.length > 0) {
        // Check if these are Shopify GIDs or Drive URLs
        const shopifyIds = fileIds.filter((id: string) => id.startsWith('gid://'));
        const driveUrls = fileIds.filter((id: string) => id.startsWith('https://drive.google.com'));

        // Resolve Shopify files
        if (shopifyIds.length > 0) {
          for (const fileId of shopifyIds) {
            try {
              const res = await admin.graphql(`
                query getFile($id: ID!) {
                  node(id: $id) {
                    ... on MediaImage {
                      image { url altText }
                      alt
                    }
                    ... on GenericFile {
                      url
                      alt
                    }
                    ... on Video {
                      sources { url mimeType }
                      alt
                    }
                  }
                }
              `, { variables: { id: fileId } });

              const data = await res.json();
              const node = data.data?.node;
              if (node) {
                if (node.image) {
                  files.push({
                    id: fileId,
                    url: node.image.url,
                    alt: node.alt || node.image.altText || "Evidence photo",
                    type: "image",
                    filename: fileId.split('/').pop() || "photo"
                  });
                } else if (node.sources) {
                  files.push({
                    id: fileId,
                    url: node.sources[0]?.url || "",
                    alt: node.alt || "Evidence video",
                    type: "video",
                    filename: fileId.split('/').pop() || "video"
                  });
                } else if (node.url) {
                  files.push({
                    id: fileId,
                    url: node.url,
                    alt: node.alt || "Evidence document",
                    type: "document",
                    filename: fileId.split('/').pop() || "document"
                  });
                }
              }
            } catch (e) {
              console.error(`Failed to resolve file ${fileId}:`, e);
            }
          }
        }

        // Add Drive URLs directly
        for (const driveUrl of driveUrls) {
          files.push({
            id: driveUrl,
            url: driveUrl,
            alt: "Evidence (Google Drive)",
            type: "drive_link",
            filename: "Google Drive file"
          });
        }
      }
    } catch (e) {
      // transactionId is not JSON — might be an exception note
      if (alert.transactionId.startsWith('Exception:')) {
        files.push({
          id: 'exception',
          url: '',
          alt: alert.transactionId,
          type: 'exception',
          filename: 'Exception Note'
        });
      }
    }
  }

  return json({
    error: null,
    alert: {
      id: alert.id,
      time: alert.time,
      person: alert.person,
      productName: alert.productName,
      details: alert.details,
      status: alert.status,
      ruleName: alert.rule.name,
      ruleDescription: alert.rule.description,
    },
    files,
    event: event ? {
      id: event.id,
      time: event.time,
      reason: event.reason,
      referenceNumber: event.referenceNumber,
      isFullyMet: event.isFullyMet,
      shopifyAdjustmentGroupId: event.shopifyAdjustmentGroupId,
      available: event.available,
    } : null
  });
};

export default function AlertEvidence() {
  const { error, alert, files, event } = useLoaderData<typeof loader>();

  if (error || !alert) {
    return (
      <Page title="Alert Not Found">
        <Layout>
          <Layout.Section>
            <Banner tone="critical">
              <p>{error || "This alert could not be found or you don't have access to it."}</p>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const shortId = alert.id.slice(-8).toUpperCase();
  const txnRef = event?.shopifyAdjustmentGroupId 
    ? event.shopifyAdjustmentGroupId.replace('gid://shopify/InventoryAdjustmentGroup/', '#')
    : null;

  return (
    <Page 
      title={`Alert ${shortId}`} 
      subtitle={`${alert.ruleName} — ${new Date(alert.time).toLocaleString()}`}
      backAction={{ content: 'Dashboard', url: '/app' }}
    >
      <Layout>
        <Layout.Section>
          {/* Alert Details */}
          <Card padding="400">
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={alert.status === 'active' ? 'attention' : 'success'}>
                  {alert.status === 'active' ? '🚨 Active' : '✅ Resolved'}
                </Badge>
                <Badge>{alert.ruleName}</Badge>
              </InlineStack>

              <Text as="h2" variant="headingLg">{alert.details}</Text>

              <Divider />

              <InlineStack gap="400">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Staff Member</Text>
                  <Text as="p" variant="bodyMd" fontWeight="bold">{alert.person}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Product</Text>
                  <Text as="p" variant="bodyMd" fontWeight="bold">{alert.productName}</Text>
                </BlockStack>
                {event?.referenceNumber && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">PO / Invoice</Text>
                    <Text as="p" variant="bodyMd" fontWeight="bold">{event.referenceNumber}</Text>
                  </BlockStack>
                )}
                {txnRef && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Shopify Transaction</Text>
                    <Text as="p" variant="bodyMd" fontWeight="bold">{txnRef}</Text>
                  </BlockStack>
                )}
              </InlineStack>

              {event && (
                <>
                  <Divider />
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={event.isFullyMet ? 'success' : 'warning'}>
                      {event.isFullyMet ? 'Fully Met' : 'Short Shipment'}
                    </Badge>
                    <Text as="p" variant="bodyMd">{event.reason}</Text>
                  </InlineStack>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Evidence Files */}
        <Layout.Section>
          <Card padding="400">
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">📎 Evidence Files ({files.length})</Text>

              {files.length === 0 && (
                <Banner tone="info">
                  <p>No evidence files were attached to this alert.</p>
                </Banner>
              )}

              {files.map((file, i) => (
                <Card key={file.id} padding="300">
                  <BlockStack gap="200">
                    {file.type === 'image' && (
                      <Box>
                        <img
                          src={file.url}
                          alt={file.alt}
                          style={{
                            maxWidth: '100%',
                            maxHeight: '500px',
                            borderRadius: '8px',
                            border: '1px solid #ddd'
                          }}
                        />
                      </Box>
                    )}

                    {file.type === 'video' && (
                      <Box>
                        <video
                          src={file.url}
                          controls
                          style={{
                            maxWidth: '100%',
                            maxHeight: '500px',
                            borderRadius: '8px',
                          }}
                        />
                      </Box>
                    )}

                    {file.type === 'document' && (
                      <Banner tone="info">
                        <p>📄 Document: <a href={file.url} target="_blank" rel="noreferrer">{file.filename}</a></p>
                      </Banner>
                    )}

                    {file.type === 'drive_link' && (
                      <Banner tone="success">
                        <p>📎 Google Drive: <a href={file.url} target="_blank" rel="noreferrer">View in Google Drive</a></p>
                      </Banner>
                    )}

                    {file.type === 'exception' && (
                      <Banner tone="warning">
                        <p>⚠️ {file.alt}</p>
                      </Banner>
                    )}

                    <Text as="p" variant="bodySm" tone="subdued">
                      Evidence File {i + 1} of {files.length}
                    </Text>
                  </BlockStack>
                </Card>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
