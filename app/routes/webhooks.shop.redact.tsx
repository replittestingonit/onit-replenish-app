import { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} for ${shop}. Purging all data...`);

  // Completely erase all footprint of this shop to comply with GDPR/CCPA.
  await prisma.triggeredAlert.deleteMany({ where: { shop } });
  await prisma.inventoryEvent.deleteMany({ where: { shop } });
  await prisma.securityRule.deleteMany({ where: { shop } });
  await prisma.appConfiguration.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });

  console.log(`Successfully wiped all data for ${shop}.`);

  return new Response("OK", { status: 200 });
};
