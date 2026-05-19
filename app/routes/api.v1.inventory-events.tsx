import { type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateApiRequest, hasScope, apiError, apiSuccess, handleCors } from "../services/api-auth.server";

// GET /api/v1/inventory-events — List events (filterable)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);
  if (!hasScope(auth, "read")) return apiError("Insufficient scope", 403);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const inventoryItemId = url.searchParams.get("inventoryItemId");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const where: any = { shop: auth.shop! };
  if (inventoryItemId) where.inventoryItemId = inventoryItemId;
  if (from || to) {
    where.time = {};
    if (from) where.time.gte = new Date(from);
    if (to) where.time.lte = new Date(to);
  }

  const [events, total] = await Promise.all([
    prisma.inventoryEvent.findMany({
      where,
      orderBy: { time: "desc" },
      take: limit,
      skip: offset
    }),
    prisma.inventoryEvent.count({ where })
  ]);

  return apiSuccess({ events, total, limit, offset });
};
