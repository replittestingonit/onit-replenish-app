/**
 * Google Drive OAuth Callback Route
 * 
 * After the owner authorizes Google Drive access, Google redirects here
 * with an authorization code. We exchange it for tokens, create the
 * evidence folder, and redirect back to Settings.
 */

import { json, redirect, type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { exchangeCodeForTokens, ensureEvidenceFolder } from "../google-drive.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state"); // This is the shop domain
  const error = url.searchParams.get("error");

  if (error) {
    console.error("[GoogleDrive OAuth] User denied access:", error);
    return redirect("/app/settings?drive_error=denied");
  }

  if (!code || !state) {
    return json({ error: "Missing code or state parameter" }, { status: 400 });
  }

  const shop = state;

  try {
    // 1. Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);

    // 2. Store tokens
    const expiry = new Date(Date.now() + tokens.expires_in * 1000);
    await prisma.appConfiguration.update({
      where: { shop },
      data: {
        googleDriveEnabled: true,
        evidenceStorage: "google_drive",
        googleDriveAccessToken: tokens.access_token,
        googleDriveRefreshToken: tokens.refresh_token,
        googleDriveTokenExpiry: expiry,
        googleDriveEmail: tokens.email || null,
      },
    });

    // 3. Create the evidence folder
    await ensureEvidenceFolder(shop, tokens.access_token);

    console.log(`[GoogleDrive] Successfully connected for ${shop} (${tokens.email})`);

    // Redirect back to settings with success flag
    return redirect("/app/settings?drive_connected=true");
  } catch (e: any) {
    console.error("[GoogleDrive OAuth] Token exchange failed:", e);
    return redirect("/app/settings?drive_error=token_failed");
  }
};
