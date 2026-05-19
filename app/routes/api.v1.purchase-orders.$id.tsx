import { type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateApiRequest, hasScope, apiError, apiSuccess, handleCors } from "../services/api-auth.server";

// GET /api/v1/purchase-orders/:id — Get PO detail
// PATCH /api/v1/purchase-orders/:id — Update draft PO
// DELETE /api/v1/purchase-orders/:id — Delete draft PO
// POST /api/v1/purchase-orders/:id — PO actions (approve, send, receive, close, cancel)
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);
  if (!hasScope(auth, "read")) return apiError("Insufficient scope", 403);

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id, shop: auth.shop! },
    include: {
      supplier: { select: { id: true, name: true, email: true, contactName: true, phone: true } },
      lineItems: true
    }
  });

  if (!po) return apiError("Purchase order not found", 404);
  return apiSuccess({ purchaseOrder: po });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const cors = handleCors(request);
  if (cors) return cors;

  const auth = await authenticateApiRequest(request);
  if (!auth.authenticated) return apiError(auth.error || "Unauthorized", 401);

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id, shop: auth.shop! },
    include: { lineItems: true }
  });
  if (!po) return apiError("Purchase order not found", 404);

  // POST — PO Actions (approve, receive, close, cancel)
  if (request.method === "POST") {
    const body = await request.json();
    const action = body.action;

    if (action === "approve") {
      if (!hasScope(auth, "admin")) return apiError("Admin scope required for approval", 403);
      // Verify manager PIN
      const config = await prisma.appConfiguration.findUnique({ where: { shop: auth.shop! } });
      const pin = body.pin;
      if (!pin) return apiError("Manager PIN is required");
      let validPin = false, managerName = "API";
      if (config?.masterOverridePin && pin === config.masterOverridePin) { validPin = true; managerName = "Owner"; }
      const delegated = JSON.parse(config?.delegatedManagerPins || "{}");
      for (const [name, mPin] of Object.entries(delegated)) {
        if (mPin === pin) { validPin = true; managerName = name; break; }
      }
      if (!validPin) return apiError("Invalid manager PIN", 403);

      await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: { status: "sent", approvedBy: managerName, approvedAt: new Date() }
      });
      return apiSuccess({ message: `PO approved by ${managerName} and marked as sent` });
    }

    if (action === "receive") {
      if (!hasScope(auth, "write")) return apiError("Write scope required", 403);
      if (!body.lineItemId || !body.qty) return apiError("lineItemId and qty are required");

      const li = po.lineItems.find(l => l.id === body.lineItemId);
      if (!li) return apiError("Line item not found", 404);

      await prisma.purchaseOrderLineItem.update({
        where: { id: li.id },
        data: {
          receivedQty: { increment: body.qty },
          receivedBy: body.receivedBy || `API (${auth.keyName})`,
          receivedAt: new Date()
        }
      });

      // Recalculate PO totals
      const updatedPO = await prisma.purchaseOrder.findUnique({
        where: { id: po.id }, include: { lineItems: true }
      });
      if (updatedPO) {
        const totalReceived = updatedPO.lineItems.reduce((s, l) => s + l.receivedQty, 0);
        const allReceived = updatedPO.lineItems.every(l => l.receivedQty >= l.orderedQty);
        await prisma.purchaseOrder.update({
          where: { id: po.id },
          data: { receivedUnits: totalReceived, status: allReceived ? "received" : "partially_received" }
        });
      }
      return apiSuccess({ message: `Received ${body.qty} units for line item` });
    }

    if (action === "close" || action === "cancel") {
      if (!hasScope(auth, "admin")) return apiError("Admin scope required", 403);
      const config = await prisma.appConfiguration.findUnique({ where: { shop: auth.shop! } });
      const pin = body.pin;
      if (!pin) return apiError("Manager PIN is required");
      let validPin = false, managerName = "API";
      if (config?.masterOverridePin && pin === config.masterOverridePin) { validPin = true; managerName = "Owner"; }
      const delegated = JSON.parse(config?.delegatedManagerPins || "{}");
      for (const [name, mPin] of Object.entries(delegated)) {
        if (mPin === pin) { validPin = true; managerName = name; break; }
      }
      if (!validPin) return apiError("Invalid manager PIN", 403);

      const newStatus = action === "close" ? "closed" : "cancelled";
      await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: { status: newStatus, approvedBy: managerName }
      });
      return apiSuccess({ message: `PO ${newStatus} by ${managerName}` });
    }

    return apiError("Unknown action. Use: approve, receive, close, cancel");
  }

  // PATCH — Update draft PO
  if (request.method === "PATCH") {
    if (!hasScope(auth, "write")) return apiError("Write scope required", 403);
    if (po.status !== "draft") return apiError("Can only update draft POs");
    const body = await request.json();
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        notes: body.notes !== undefined ? body.notes : po.notes,
        expectedDate: body.expectedDate ? new Date(body.expectedDate) : po.expectedDate
      }
    });
    return apiSuccess({ message: "PO updated" });
  }

  // DELETE — Delete draft PO
  if (request.method === "DELETE") {
    if (!hasScope(auth, "admin")) return apiError("Admin scope required", 403);
    if (po.status !== "draft") return apiError("Can only delete draft POs");
    await prisma.purchaseOrder.delete({ where: { id: po.id } });
    return apiSuccess({ message: "PO deleted" });
  }

  return apiError("Method not allowed", 405);
};
