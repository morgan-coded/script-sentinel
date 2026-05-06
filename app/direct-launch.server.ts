import { redirect } from "@remix-run/node";

const SHOPIFY_LAUNCH_PARAMS = [
  "host",
  "embedded",
  "id_token",
  "hmac",
  "timestamp",
] as const;

const SHOPIFY_SESSION_COOKIE_RE =
  /(?:^|;\s*)(shopify_app_session|shopify_app_session\.sig|__session)=/;

export function redirectDirectAppLaunch(request: Request): void {
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!url.pathname.startsWith("/app")) return;
  if (request.headers.get("authorization")) return;

  const cookie = request.headers.get("cookie") ?? "";
  if (SHOPIFY_SESSION_COOKIE_RE.test(cookie)) return;

  if (SHOPIFY_LAUNCH_PARAMS.some((param) => url.searchParams.has(param))) {
    return;
  }

  const shop = url.searchParams.get("shop");
  throw redirect(
    shop ? `/auth/login?shop=${encodeURIComponent(shop)}` : "/auth/login",
  );
}
