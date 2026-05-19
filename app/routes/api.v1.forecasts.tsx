import { type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateApiRequest, hasScope, apiError, apiSuccess, handleCors } from "../services/api-auth.server";

// GET /api/v1/forecasts — List all forecasts
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);
  if (!hasScope(auth, "read")) return apiError("Insufficient scope", 403);

  const forecasts = await prisma.demandForecast.findMany({
    where: { shop: auth.shop! },
    orderBy: { updatedAt: "desc" }
  });

  const reorderConfigs = await prisma.reorderConfig.findMany({
    where: { shop: auth.shop! }
  });

  return apiSuccess({ forecasts, reorderConfigs });
};
