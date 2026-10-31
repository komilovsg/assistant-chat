/*
 * Public AI chat backend: one Cloudflare Worker + static assets (./public).
 *
 * GET /api/config  (public, cached 5 min)
 *   → { appName, greeting, models: [{ id, label }], maxInputChars }
 *   `models` is the fallback order used by "auto"; "auto" itself is always accepted and is not listed.
 *
 * POST /api/chat
 *   Request (application/json, <= 32 KB):
 *     { "model": "auto" | "<id from /api/config models>", "messages": [{ "role": "user" | "model", "text": "..." }, ...] }
 *     1..40 messages, last one role "user" (<= maxInputChars). Server keeps the last 12 (~20k chars) as context.
 *
 *   Errors (before streaming): non-2xx + JSON { "error": code, "message": "<ru text>", "retryAfter"?: seconds }
 *     400 bad_request | invalid_model     403 forbidden_origin     405 method_not_allowed
 *     413 too_large    415 unsupported_media_type
 *     429 rate_limited | daily_ip | daily_global   (+ Retry-After header)
 *     503 unavailable (all models failed)          500 config (server misconfigured)
 *
 *   Success: 200 text/event-stream, header X-Remaining-Today: <per-IP requests left today>.
 *   Every event is one line `data: <json>\n\n`, in this order:
 *     data: {"type":"meta","model":"gemini-3.5-flash"}     exactly once, first
 *     data: {"type":"delta","text":"..."}                   0..n, append text in order
 *     data: {"type":"error","message":"<ru text>"}          0..1, upstream broke mid-answer
 *     data: {"type":"done","status":"completed"|"incomplete"}   exactly once, last
 *   "incomplete" = answer cut (token limit / error). Client closes the connection → upstream is aborted.
 *
 * Cross-origin (embedded widget): /api/* answer CORS only for origins in ALLOWED_ORIGINS (see originAllowed);
 * others get 403 forbidden_origin. Rate limits are per IP regardless of origin. /widget.js is public (ACAO *).
 *
 * Upstream: Gemini Interactions API, stream:true. Its SSE (probed 2026-10-31) is
 *   `event: <name>\ndata: <json>\n\n` with data.event_type in: interaction.created, interaction.status_update,
 *   step.start {step:{type:"thought"|"model_output"}}, step.delta {delta:{type:"text",text} | {type:"thought_signature"}},
 *   step.stop, interaction.completed {interaction:{status:"completed"|"incomplete", usage}}; then `data: [DONE]`.
 * Nothing the user writes is logged or stored.
 */
import { DAY_TTL, MAX_BODY, MAX_LAST, MODELS, getConfig, type Config, type Env } from "./server/config";
import { markDead, pacificDay, secondsToPacificMidnight } from "./server/limits";
import { pump, tryModel, type Started } from "./server/gemini";
import { fail, isCrossOrigin, json, originAllowed, preflight, publicScript, secure, withCors } from "./server/http";
import { toInput, validate, type ChatBody } from "./server/validate";

export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/widget.js") return publicScript(await env.ASSETS.fetch(request));
    if (path !== "/api/chat" && path !== "/api/config") return secure(await env.ASSETS.fetch(request));

    const cfg = getConfig(env);
    const origin = request.headers.get("Origin");
    if (!originAllowed(origin, url.origin, cfg.allowedOrigins))
      return secure(fail(403, "forbidden_origin", "Запрос с чужого сайта отклонён."));
    const cross = isCrossOrigin(origin, url.origin);
    if (request.method === "OPTIONS")
      return secure(cross ? preflight(origin) : new Response(null, { status: 204, headers: { Allow: "GET, POST, OPTIONS" } }));

    let res = path === "/api/config" ? config(request, cfg) : await chat(request, env, ctx, cfg);
    if (cross) res = withCors(res, origin);
    return secure(res);
  },
} satisfies ExportedHandler<Env>;

function config(request: Request, cfg: Config): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return fail(405, "method_not_allowed", "Только GET.", {}, { Allow: "GET" });
  return json(200, {
    appName: cfg.appName,
    greeting: cfg.greeting,
    models: MODELS.map(({ id, label }) => ({ id, label })),
    maxInputChars: MAX_LAST,
  }, { "Cache-Control": "public, max-age=300", Vary: "Origin" });
}

async function chat(request: Request, env: Env, ctx: ExecutionContext, cfg: Config): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method_not_allowed", "Только POST.", {}, { Allow: "POST" });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  // Burst limit first, so even junk requests are throttled.
  if (env.BURST && !(await env.BURST.limit({ key: ip })).success)
    return fail(429, "rate_limited", "Слишком много запросов. Подождите минуту.", { retryAfter: 60 }, { "Retry-After": "60" });

  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json"))
    return fail(415, "unsupported_media_type", "Нужен Content-Type: application/json.");
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) return fail(413, "too_large", "Сообщение слишком большое.");
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY) return fail(413, "too_large", "Сообщение слишком большое.");

  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(raw)); } catch { return fail(400, "bad_request", "Некорректный JSON."); }
  const bad = validate(parsed);
  if (bad) return fail(400, "bad_request", bad);
  const body = parsed as ChatBody;
  const auto = body.model === "auto";
  const chain = auto ? MODELS : MODELS.filter((m) => m.id === body.model);
  if (!chain.length) return fail(400, "invalid_model", "Неизвестная модель.");

  // Daily caps (Pacific day = Google quota reset).
  // ponytail: KV is eventually consistent (and allows ~1 write/s per key), so concurrent requests can overshoot
  // the counts a bit. Upgrade path: a Durable Object counter for exact limits.
  const kv = env.LIMITS, day = pacificDay();
  const ipKey = `ip:${day}:${ip}`, gKey = `global:${day}`, deadKey = `dead:${day}`;
  const [a, b, c] = await Promise.all([kv.get(ipKey), kv.get(gKey), kv.get<string[]>(deadKey, "json")]);
  const ipN = Number(a) || 0, gN = Number(b) || 0, dead = c ?? [];
  const retryAfter = secondsToPacificMidnight();
  if (ipN >= cfg.dailyIpLimit)
    return fail(429, "daily_ip", "Дневной лимит сообщений исчерпан. Возвращайтесь завтра.", { retryAfter },
      { "Retry-After": String(retryAfter), "X-Remaining-Today": "0" });
  if (gN >= cfg.dailyGlobalLimit)
    return fail(429, "daily_global", "Сервис исчерпал дневной лимит для всех пользователей. Возвращайтесь завтра.", { retryAfter },
      { "Retry-After": String(retryAfter) });
  ctx.waitUntil(Promise.all([
    kv.put(ipKey, String(ipN + 1), { expirationTtl: DAY_TTL }),
    kv.put(gKey, String(gN + 1), { expirationTtl: DAY_TTL }),
  ]).catch((e) => console.log("kv_put_failed", String(e))));
  const remaining = String(Math.max(0, cfg.dailyIpLimit - ipN - 1));

  const input = toInput(body.messages);
  const newlyDead: string[] = [];
  let started: { s: Started; model: string } | null = null;
  for (const m of chain) {
    if (auto && dead.includes(m.id)) continue;
    const r = await tryModel(m, input, env.GEMINI_API_KEY, cfg.systemPrompt, request.signal);
    console.log(JSON.stringify({ model: m.id, upstream: r.status, result: r.kind }));
    if (r.kind === "ok") { started = { s: r, model: m.id }; break; }
    if (r.kind === "dead") newlyDead.push(m.id);
    if (r.kind === "config") return fail(500, "config", "Сервис временно недоступен.");
  }
  if (newlyDead.length) ctx.waitUntil(markDead(kv, deadKey, newlyDead));
  if (!started) return fail(503, "unavailable", "Все модели сейчас недоступны. Попробуйте позже.", { retryAfter: 60 }, { "X-Remaining-Today": remaining });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  ctx.waitUntil(pump(started.s, started.model, writable.getWriter()));
  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Remaining-Today": remaining },
  });
}
