// Response helpers, security headers, origin allowlist and CORS.

// No 'unsafe-inline': the frontend has no inline <script>/<style>/handlers; libraries are bundled into /app.js.
// Inter comes from Google Fonts.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

/** Copies a response with the site-wide security headers (CSP etc.). */
export function secure(res: Response): Response {
  const r = new Response(res.body, res);
  r.headers.set("Content-Security-Policy", CSP);
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  r.headers.set("Permissions-Policy", "microphone=(self)");
  return r;
}

/** /widget.js is a public script loaded by other sites: no CSP, cross-origin readable, short cache (file name is not hashed). */
export function publicScript(res: Response): Response {
  const r = new Response(res.body, res);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  r.headers.set("X-Content-Type-Options", "nosniff");
  if (res.ok) r.headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  return r;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

export const fail = (
  status: number, error: string, message: string,
  extra: Record<string, unknown> = {}, headers: Record<string, string> = {},
): Response => json(status, { error, message, ...extra }, headers);

const isLocal = (o: string): boolean => {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(o).hostname); } catch { return false; }
};

/**
 * May a browser on `origin` call our API?
 * - no Origin header (same-origin GET, curl) or our own origin → yes; localhost ↔ localhost (any port) → yes (dev).
 * - otherwise only if listed in ALLOWED_ORIGINS: comma list of exact origins ("https://a.com,https://b.org"), or "*".
 *
 * ABUSE NOTE: "*" lets ANY website embed the widget and spend YOUR Gemini quota / daily global cap with its
 * visitors' traffic. Per-IP limits still apply, but the global cap is shared. Prefer an explicit list.
 * The Origin check only stops browsers; scripts can forge Origin, which is why the IP/global limits exist.
 */
export function originAllowed(origin: string | null, selfOrigin: string, allowed: string): boolean {
  if (!origin || origin === selfOrigin) return true;
  if (isLocal(origin) && isLocal(selfOrigin)) return true;
  const list = allowed.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.includes(origin);
}

/** True when a CORS-enabled response is needed (allowed origin that is not our own). */
export const isCrossOrigin = (origin: string | null, selfOrigin: string): origin is string =>
  !!origin && origin !== selfOrigin;

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "X-Remaining-Today, Retry-After",
    Vary: "Origin",
  };
}

export function preflight(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

/** Adds CORS headers to an API response (any status, so the widget can read error JSON). */
export function withCors(res: Response, origin: string): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(origin))) r.headers.set(k, v);
  return r;
}
