import { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} for ${shop}`);
  
  // We do not export customer data directly. We only hold order metadata 
  // for security auditing, which does not constitute exportable marketing PII.
  return new Response("OK", { status: 200 });
};
