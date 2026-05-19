import prisma from "../db.server";
import crypto from "crypto";

export interface ApiAuthResult {
  authenticated: boolean;
  shop?: string;
  scope?: string;
  keyName?: string;
  error?: string;
}

// Rate limiting: in-memory store (resets on restart — production would use Redis)
const rateLimitStore: Map<string, { count: number; resetAt: number }> = new Map();
const RATE_LIMIT = 100; // requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute

/**
 * Authenticate an API request via X-ONIT-API-Key header
 */
export async function authenticateApiRequest(request: Request): Promise<ApiAuthResult> {
  const apiKey = request.headers.get("X-ONIT-API-Key");
  const shopHeader = request.headers.get("X-ONIT-Shop");

  if (!apiKey) {
    return { authenticated: false, error: "Missing X-ONIT-API-Key header" };
  }
  if (!shopHeader) {
    return { authenticated: false, error: "Missing X-ONIT-Shop header" };
  }

  // Look up key
  const keyRecord = await prisma.apiKey.findUnique({ where: { key: apiKey } });

  if (!keyRecord) {
    return { authenticated: false, error: "Invalid API key" };
  }
  if (!keyRecord.isActive) {
    return { authenticated: false, error: "API key has been revoked" };
  }
  if (keyRecord.shop !== shopHeader) {
    return { authenticated: false, error: "API key does not match the specified shop" };
  }

  // Rate limiting
  const now = Date.now();
  const bucket = rateLimitStore.get(apiKey);
  if (bucket) {
    if (now > bucket.resetAt) {
      rateLimitStore.set(apiKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    } else {
      bucket.count++;
      if (bucket.count > RATE_LIMIT) {
        return { authenticated: false, error: "Rate limit exceeded (100 req/min)" };
      }
    }
  } else {
    rateLimitStore.set(apiKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
  }

  // Update last used timestamp (fire and forget)
  prisma.apiKey.update({
    where: { id: keyRecord.id },
    data: { lastUsedAt: new Date() }
  }).catch(() => {});

  return {
    authenticated: true,
    shop: keyRecord.shop,
    scope: keyRecord.scope,
    keyName: keyRecord.name
  };
}

/**
 * Check if the authenticated scope has sufficient permissions
 */
export function hasScope(auth: ApiAuthResult, required: "read" | "write" | "admin"): boolean {
  if (!auth.authenticated || !auth.scope) return false;
  const hierarchy = { read: 1, write: 2, admin: 3 };
  return (hierarchy[auth.scope as keyof typeof hierarchy] || 0) >= hierarchy[required];
}

/**
 * Build a JSON error response
 */
export function apiError(message: string, status: number = 400): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

/**
 * Build a JSON success response
 */
export function apiSuccess(data: any, status: number = 200): Response {
  return new Response(JSON.stringify({ success: true, ...data }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

/**
 * Generate a new API key string
 */
export function generateApiKey(): string {
  return `onit_sk_${crypto.randomBytes(32).toString("hex")}`;
}

/**
 * Handle CORS preflight
 */
export function handleCors(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-ONIT-API-Key, X-ONIT-Shop",
        "Access-Control-Max-Age": "86400"
      }
    });
  }
  return null;
}
