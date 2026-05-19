import { type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateApiRequest, hasScope, apiError, apiSuccess, handleCors } from "../services/api-auth.server";

// GET /api/v1/purchase-orders — List POs (filterable by status, supplier)
// POST /api/v1/purchase-orders — Create a draft PO (write scope)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);
  if (!hasScope(auth, "read")) return apiError("Insufficient scope", 403);

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const supplierId = url.searchParams.get("supplierId");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const where: any = { shop: auth.shop! };
  if (status) where.status = status;
  if (supplierId) where.supplierId = supplierId;

  const [purchaseOrders, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: { supplier: { select: { id: true, name: true, email: true } }, lineItems: true },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset
    }),
    prisma.purchaseOrder.count({ where })
  ]);

  return apiSuccess({ purchaseOrders, total, limit, offset });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);

  if (request.method === "POST") {
    if (!hasScope(auth, "write")) return apiError("Insufficient scope — write required", 403);

    const body = await request.json();
    if (!body.supplierId) return apiError("supplierId is required");
    if (!body.lineItems || !body.lineItems.length) return apiError("lineItems are required");

    // Check authorization
    const config = await prisma.appConfiguration.findUnique({ where: { shop: auth.shop! } });
    const authorized: string[] = JSON.parse(config?.poAuthorizedStaff || "[]");
    const createdBy = body.createdBy || `API (${auth.keyName})`;
    if (authorized.length > 0 && !authorized.includes(createdBy) && createdBy !== "Owner") {
      return apiError("Not authorized to create purchase orders", 403);
    }

    // Generate PO number
    const year = new Date().getFullYear();
    const lastPO = await prisma.purchaseOrder.findFirst({
      where: { shop: auth.shop!, poNumber: { startsWith: `PO-${year}-` } },
      orderBy: { poNumber: "desc" }
    });
    const nextSeq = lastPO ? parseInt(lastPO.poNumber.split("-")[2], 10) + 1 : 1;
    const poNumber = `PO-${year}-${nextSeq.toString().padStart(4, "0")}`;

    let totalCost = 0, totalUnits = 0;
    for (const li of body.lineItems) {
      totalCost += (li.qty || li.orderedQty || 0) * (li.unitCost || li.cost || 0);
      totalUnits += li.qty || li.orderedQty || 0;
    }

    const po = await prisma.purchaseOrder.create({
      data: {
        shop: auth.shop!,
        poNumber,
        supplierId: body.supplierId,
        createdBy,
        notes: body.notes || null,
        expectedDate: body.expectedDate ? new Date(body.expectedDate) : null,
        totalCost,
        totalUnits,
        lineItems: {
          create: body.lineItems.map((li: any) => ({
            inventoryItemId: li.inventoryItemId,
            productName: li.productName,
            sku: li.sku || null,
            orderedQty: li.qty || li.orderedQty,
            unitCost: li.unitCost || li.cost || 0
          }))
        }
      },
      include: { lineItems: true }
    });

    return apiSuccess({
      purchaseOrder: {
        id: po.id,
        poNumber: po.poNumber,
        status: po.status,
        totalUnits: po.totalUnits,
        totalCost: po.totalCost,
        message: "PO created as draft. Requires manager approval before sending."
      }
    }, 201);
  }

  return apiError("Method not allowed", 405);
};
