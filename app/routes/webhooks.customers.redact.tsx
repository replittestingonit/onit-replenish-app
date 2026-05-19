import { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} for ${shop}`);
  
  const customerEmail = payload.customer?.email;
  const customerPhone = payload.customer?.phone;

  if (customerEmail || customerPhone) {
    const alerts = await prisma.triggeredAlert.findMany({ where: { shop } });
    for (const alert of alerts) {
      const details = alert.details || "";
      const person = alert.person || "";
      
      const hasEmail = customerEmail && (details.includes(customerEmail) || person.includes(customerEmail));
      const hasPhone = customerPhone && (details.includes(customerPhone) || person.includes(customerPhone));

      if (hasEmail || hasPhone) {
        await prisma.triggeredAlert.update({
          where: { id: alert.id },
          data: {
            person: "REDACTED (GDPR/CCPA)",
            details: "Alert details redacted per customer data deletion request."
          }
        });
      }
    }
  }

  return new Response("OK", { status: 200 });
};
