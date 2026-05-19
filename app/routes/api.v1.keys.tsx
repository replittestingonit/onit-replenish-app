import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { generateApiKey } from "../services/api-auth.server";

// These endpoints use Shopify session auth (not API key auth)
// Only accessible from the app settings UI

// GET — List active API keys (masked)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const keys = await prisma.apiKey.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, scope: true, isActive: true,
      lastUsedAt: true, createdAt: true, createdBy: true,
      key: true // We'll mask this before returning
    }
  });

  // Mask keys: show only first 12 chars
  const maskedKeys = keys.map(k => ({
    ...k,
    key: k.key.substring(0, 12) + "..." + k.key.substring(k.key.length - 4)
  }));

  return json({ keys: maskedKeys });
};

// POST — Create or manage API keys
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "createKey") {
    const name = formData.get("name") as string;
    const scope = formData.get("scope") as string || "read";
    const createdBy = formData.get("createdBy") as string || "Owner";

    if (!name) return json({ error: "Key name is required" }, { status: 400 });

    const key = generateApiKey();
    const apiKey = await prisma.apiKey.create({
      data: { shop, name, key, scope, createdBy }
    });

    // Return the FULL key only on creation — never shown again
    return json({ success: true, apiKey: { id: apiKey.id, name: apiKey.name, key, scope: apiKey.scope } });
  }

  if (actionType === "revokeKey") {
    const keyId = formData.get("keyId") as string;
    await prisma.apiKey.update({
      where: { id: keyId },
      data: { isActive: false }
    });
    return json({ success: true });
  }

  if (actionType === "deleteKey") {
    const keyId = formData.get("keyId") as string;
    await prisma.apiKey.delete({ where: { id: keyId } });
    return json({ success: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};
