import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { redirectDirectAppLaunch } from "./direct-launch.server";
import { buildBillingConfig } from "./lib/billing/products";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Shopify Managed Billing — four SKUs centralised in app/lib/billing/products.ts:
  //   $199 one-time Migration Risk Audit, $499 one-time Multi-Script Audit,
  //   $149/mo Regression Suite (Discount), $299/mo Regression Suite (All).
  billing: buildBillingConfig(),
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;

const baseAuthenticate = shopify.authenticate;

export const authenticate: typeof baseAuthenticate = {
  ...baseAuthenticate,
  admin: (async (...args: Parameters<typeof baseAuthenticate.admin>) => {
    redirectDirectAppLaunch(args[0]);
    return baseAuthenticate.admin(...args);
  }) as typeof baseAuthenticate.admin,
};

export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
