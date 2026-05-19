/**
 * Google Drive Upload API Route
 * 
 * When the shop has Google Drive enabled, the adjust page sends files here
 * instead of using Shopify's staged upload pipeline. Files are uploaded
 * directly to the owner's private Google Drive evidence folder.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getValidAccessToken, ensureEvidenceFolder, uploadFileToDrive } from "../google-drive.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const config = await prisma.appConfiguration.findUnique({ where: { shop } });
  if (!config?.googleDriveEnabled) {
    return json({ error: "Google Drive is not enabled for this store" }, { status: 400 });
  }

  // Get valid access token (auto-refreshes if expired)
  const accessToken = await getValidAccessToken(shop);
  if (!accessToken) {
    return json({ error: "Google Drive authentication expired. Please reconnect in Settings." }, { status: 401 });
  }

  try {
    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get("file") as File;
    const staffName = formData.get("staffName") as string;
    const referenceNumber = formData.get("referenceNumber") as string;

    if (!file || !(file instanceof File)) {
      return json({ error: "No file provided" }, { status: 400 });
    }

    // Ensure the evidence folder exists
    const folderId = await ensureEvidenceFolder(shop, accessToken);

    // Read the file into a buffer
    const arrayBuffer = await file.arrayBuffer();

    // Upload to Drive
    const result = await uploadFileToDrive(
      accessToken,
      folderId,
      file.name,
      arrayBuffer,
      file.type || "application/octet-stream",
      { staffName, referenceNumber, shop }
    );

    return json({
      success: true,
      fileId: result.fileId,
      viewLink: result.viewLink,
    });
  } catch (err: any) {
    console.error("[GoogleDrive Upload] Error:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
