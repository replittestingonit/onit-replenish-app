import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import shopify, { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  
  let hasEnterprise = false;
  
  try {
    const billingCheck = await billing.check({
      plans: ["Dashboard Protection", "Enterprise WMS Suite"],
      isTest: false,
    });

    if (!billingCheck.hasActivePayment) {
      return await billing.request({ plan: "Dashboard Protection", isTest: false });
    }

    hasEnterprise = billingCheck.appSubscriptions.some(
      (sub: any) => sub.name === "Enterprise WMS Suite"
    );
  } catch (err: any) {
    console.warn("Billing API bypassed (likely a custom app):", err.message);
    hasEnterprise = true; // Unlock all features for custom app development
  }
  
  // Dynamically register webhooks for any store that loads the app
  try {
    await shopify.registerWebhooks({ session });
  } catch (err) {
    console.error("Failed to register webhooks:", err);
  }

  return { apiKey: process.env.SHOPIFY_API_KEY || "", hasEnterprise };
};

export default function App() {
  const { apiKey, hasEnterprise } = useLoaderData<typeof loader>();

  const ENABLE_WMS_SUITE = hasEnterprise;

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        {ENABLE_WMS_SUITE && <Link to="/app/receive">Receiving</Link>}
        <Link to="/app/adjust">Change</Link>
        {ENABLE_WMS_SUITE && <Link to="/app/fulfill">Ship Out</Link>}
        <Link to="/app/forecast">Forecast</Link>
        <Link to="/app/purchase-orders">Purchase Orders</Link>
        <Link to="/app/settings">App Settings</Link>
      </NavMenu>
      <Outlet context={{ ENABLE_WMS_SUITE }} />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
