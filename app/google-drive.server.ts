/**
 * Google Drive Evidence Storage Service
 * 
 * Handles OAuth token management, folder creation, file uploads,
 * and permission-controlled link generation for enterprise evidence storage.
 * 
 * When enabled, evidence (photos, videos, PDFs) is uploaded to the owner's
 * private Google Drive instead of being attached to alert emails.
 * Emails still fire — they just contain a link, not the file itself.
 */

import prisma from "./db.server";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";

// -------------------------------------------------------------------
// OAuth Helpers
// -------------------------------------------------------------------

/**
 * Build the Google OAuth consent URL.
 * Scope: drive.file — we can only see files we create, not the user's entire Drive.
 */
export function getGoogleAuthUrl(shop: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
    access_type: "offline",
    prompt: "consent",
    state: shop, // We pass shop as state so we know who to associate tokens with
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange the OAuth authorization code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  email?: string;
}> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  const data = await res.json();

  // Fetch user email
  let email: string | undefined;
  try {
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      email = profile.email;
    }
  } catch (e) {
    console.error("Failed to fetch Google profile email:", e);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    email,
  };
}

/**
 * Refresh an expired access token using the stored refresh token.
 */
async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token refresh failed: ${err}`);
  }

  return await res.json();
}

/**
 * Get a valid access token for the shop — refreshing if expired.
 */
export async function getValidAccessToken(shop: string): Promise<string | null> {
  const config = await prisma.appConfiguration.findUnique({ where: { shop } });
  if (!config?.googleDriveRefreshToken) return null;

  // Check if current token is still valid (with 5-minute buffer)
  if (config.googleDriveAccessToken && config.googleDriveTokenExpiry) {
    const buffer = 5 * 60 * 1000; // 5 minutes
    if (new Date(config.googleDriveTokenExpiry).getTime() > Date.now() + buffer) {
      return config.googleDriveAccessToken;
    }
  }

  // Token expired — refresh it
  try {
    const { access_token, expires_in } = await refreshAccessToken(config.googleDriveRefreshToken);
    const expiry = new Date(Date.now() + expires_in * 1000);

    await prisma.appConfiguration.update({
      where: { shop },
      data: {
        googleDriveAccessToken: access_token,
        googleDriveTokenExpiry: expiry,
      },
    });

    return access_token;
  } catch (e) {
    console.error(`[GoogleDrive] Token refresh failed for ${shop}:`, e);
    return null;
  }
}

// -------------------------------------------------------------------
// Drive Operations
// -------------------------------------------------------------------

/**
 * Create the evidence folder in the user's Drive if it doesn't exist.
 * Returns the folder ID.
 */
export async function ensureEvidenceFolder(shop: string, accessToken: string): Promise<string> {
  const config = await prisma.appConfiguration.findUnique({ where: { shop } });
  
  // If we already have a folder ID, verify it still exists
  if (config?.googleDriveFolderId) {
    try {
      const checkRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${config.googleDriveFolderId}?fields=id,trashed`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (checkRes.ok) {
        const folder = await checkRes.json();
        if (!folder.trashed) return config.googleDriveFolderId;
      }
    } catch (e) {
      console.error("[GoogleDrive] Folder check failed, will create new:", e);
    }
  }

  // Create a new folder
  const shopName = shop.replace(".myshopify.com", "");
  const folderRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `Inventory Protection Evidence — ${shopName}`,
      mimeType: "application/vnd.google-apps.folder",
      description: `Secure evidence storage for ${shop}. Photos, videos, and documents uploaded by warehouse staff during inventory adjustments.`,
    }),
  });

  if (!folderRes.ok) {
    const err = await folderRes.text();
    throw new Error(`Failed to create Drive folder: ${err}`);
  }

  const folder = await folderRes.json();

  // Save the folder ID
  await prisma.appConfiguration.update({
    where: { shop },
    data: { googleDriveFolderId: folder.id },
  });

  return folder.id;
}

/**
 * Upload a file to the evidence folder in Google Drive.
 * Returns an object with the file ID and a shareable view link.
 */
export async function uploadFileToDrive(
  accessToken: string,
  folderId: string,
  fileName: string,
  fileBuffer: Buffer | ArrayBuffer,
  mimeType: string,
  metadata?: {
    staffName?: string;
    referenceNumber?: string;
    shop?: string;
  }
): Promise<{ fileId: string; viewLink: string }> {
  // Build description from metadata
  const descParts: string[] = [];
  if (metadata?.staffName) descParts.push(`Staff: ${metadata.staffName}`);
  if (metadata?.referenceNumber) descParts.push(`Ref: ${metadata.referenceNumber}`);
  if (metadata?.shop) descParts.push(`Store: ${metadata.shop}`);
  descParts.push(`Uploaded: ${new Date().toISOString()}`);

  // Use multipart upload for files under 5MB, resumable for larger
  const boundary = "evidence_boundary_" + Date.now();
  const metadataObj = {
    name: fileName,
    parents: [folderId],
    description: descParts.join(" | "),
  };

  const metadataStr = JSON.stringify(metadataObj);
  const buffer = fileBuffer instanceof Buffer ? fileBuffer : Buffer.from(fileBuffer);

  // Build multipart body
  const bodyParts = [
    `--${boundary}\r\n`,
    `Content-Type: application/json; charset=UTF-8\r\n\r\n`,
    `${metadataStr}\r\n`,
    `--${boundary}\r\n`,
    `Content-Type: ${mimeType}\r\n\r\n`,
  ];

  const headerBuffer = Buffer.from(bodyParts.join(""));
  const footerBuffer = Buffer.from(`\r\n--${boundary}--`);
  const fullBody = Buffer.concat([headerBuffer, buffer, footerBuffer]);

  const uploadRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": fullBody.length.toString(),
      },
      body: fullBody,
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Drive upload failed: ${err}`);
  }

  const file = await uploadRes.json();
  return {
    fileId: file.id,
    viewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
  };
}

/**
 * Upload a file from a URL (e.g., a Shopify staged upload resourceUrl) to Drive.
 * Downloads the file first, then uploads to Drive.
 */
export async function uploadUrlToDrive(
  accessToken: string,
  folderId: string,
  sourceUrl: string,
  fileName: string,
  mimeType: string,
  metadata?: {
    staffName?: string;
    referenceNumber?: string;
    shop?: string;
  }
): Promise<{ fileId: string; viewLink: string }> {
  // Download from source
  const downloadRes = await fetch(sourceUrl);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download from source URL: ${downloadRes.status}`);
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  return uploadFileToDrive(accessToken, folderId, fileName, arrayBuffer, mimeType, metadata);
}

// -------------------------------------------------------------------
// Disconnect
// -------------------------------------------------------------------

/**
 * Revoke Google Drive access and clear stored tokens.
 */
export async function disconnectGoogleDrive(shop: string): Promise<void> {
  const config = await prisma.appConfiguration.findUnique({ where: { shop } });

  // Attempt to revoke the token at Google
  if (config?.googleDriveRefreshToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${config.googleDriveRefreshToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch (e) {
      console.error("[GoogleDrive] Token revocation failed (non-critical):", e);
    }
  }

  await prisma.appConfiguration.update({
    where: { shop },
    data: {
      evidenceStorage: "email",
      googleDriveEnabled: false,
      googleDriveFolderId: null,
      googleDriveAccessToken: null,
      googleDriveRefreshToken: null,
      googleDriveTokenExpiry: null,
      googleDriveEmail: null,
    },
  });
}
