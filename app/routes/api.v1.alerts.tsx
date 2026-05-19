import { type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateApiRequest, hasScope, apiError, apiSuccess, handleCors } from "../services/api-auth.server";

// GET /api/v1/alerts — List triggered alerts
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);
  if (!hasScope(auth, "read")) return apiError("Insufficient scope", 403);

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);

  const where: any = { shop: auth.shop! };
  if (status) where.status = status;

  const alerts = await prisma.triggeredAlert.findMany({
    where,
    include: { rule: { select: { name: true, triggerType: true } } },
    orderBy: { time: "desc" },
    take: limit
  });

  return apiSuccess({ alerts });
};

// PATCH /api/v1/alerts/:id — Update alert status
export const action = async ({ request }: ActionFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);

  if (request.method === "PATCH") {
    if (!hasScope(auth, "write")) return apiError("Write scope required", 403);
    const body = await request.json();
    if (!body.id || !body.status) return apiError("id and status are required");

    await prisma.triggeredAlert.update({
      where: { id: body.id },
      data: { status: body.status }
    });
    return apiSuccess({ message: "Alert updated" });
  }

  return apiError("Method not allowed", 405);
};
