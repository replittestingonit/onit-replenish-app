import { type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateApiRequest, hasScope, apiError, apiSuccess, handleCors } from "../services/api-auth.server";

// GET /api/v1/suppliers — List all suppliers
// POST /api/v1/suppliers — Create a supplier (write scope)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);
  if (!hasScope(auth, "read")) return apiError("Insufficient scope", 403);

  const suppliers = await prisma.supplier.findMany({
    where: { shop: auth.shop! },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, contactName: true, email: true,
      phone: true, address: true, leadTimeDays: true, notes: true,
      createdAt: true, updatedAt: true
    }
  });

  return apiSuccess({ suppliers });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);

  if (request.method === "POST") {
    if (!hasScope(auth, "write")) return apiError("Insufficient scope — write required", 403);
    const body = await request.json();
    if (!body.name) return apiError("name is required");

    const supplier = await prisma.supplier.create({
      data: {
        shop: auth.shop!,
        name: body.name,
        email: body.email || null,
        contactName: body.contactName || null,
        phone: body.phone || null,
        address: body.address || null,
        leadTimeDays: body.leadTimeDays || 14,
        notes: body.notes || null
      }
    });
    return apiSuccess({ supplier }, 201);
  }

  return apiError("Method not allowed", 405);
};
