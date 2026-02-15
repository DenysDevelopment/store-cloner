import { authenticate } from "../shopify.server.js";

export const action = async ({ request }) => {
  const { topic, shop, session, admin } = await authenticate.webhook(request);
  if (!admin) throw new Response();
  switch (topic) {
    case "APP_UNINSTALLED": break;
    case "CUSTOMERS_DATA_REQUEST": case "CUSTOMERS_REDACT": case "SHOP_REDACT": break;
    default: throw new Response("Unhandled webhook", { status: 404 });
  }
  throw new Response();
};
