/** Network layer shared by the full-page chat and the widget. `base` = "" (same origin) or an absolute origin. */

export interface ModelInfo { id: string; label: string }
export interface AppConfig { appName: string; greeting: string; models: ModelInfo[]; maxInputChars: number }
export interface ChatMsg { role: "user" | "model"; text: string }

export type StreamEvent =
  | { type: "remaining"; value: number }
  | { type: "meta"; model: string }
  | { type: "delta"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; status: "completed" | "incomplete" };

export type ApiErrorKind = "forbidden_origin" | "rate_limited" | "daily_ip" | "daily_global" | "http" | "network";

export class ApiError extends Error {
  constructor(
    public kind: ApiErrorKind,
    message: string,
    public status = 0,
    public retryAfter = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const DEFAULT_CONFIG: AppConfig = { appName: "Ассистент", greeting: "", models: [], maxInputChars: 4000 };

export async function getConfig(base: string): Promise<AppConfig> {
  try {
    const res = await fetch(base + "/api/config");
    if (!res.ok) return DEFAULT_CONFIG;
    const d = (await res.json()) as Partial<AppConfig>;
    return {
      appName: typeof d.appName === "string" && d.appName ? d.appName : DEFAULT_CONFIG.appName,
      greeting: typeof d.greeting === "string" ? d.greeting : "",
      models: Array.isArray(d.models) ? d.models.filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id, label: String(m.label || m.id) })) : [],
      maxInputChars: typeof d.maxInputChars === "number" && d.maxInputChars > 0 ? d.maxInputChars : DEFAULT_CONFIG.maxInputChars,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const KNOWN: ApiErrorKind[] = ["forbidden_origin", "rate_limited", "daily_ip", "daily_global"];

/**
 * POST /api/chat (SSE). Emits typed events; resolves when the stream ends.
 * Throws ApiError for non-2xx / network failures and the native AbortError on abort.
 */
export async function streamChat(
  base: string,
  model: string,
  messages: ChatMsg[],
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, text: m.text })) }),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("network", "Ошибка сети. Проверьте соединение и попробуйте ещё раз.");
  }
  const rem = res.headers.get("X-Remaining-Today");
  if (rem !== null && rem !== "" && !isNaN(+rem)) onEvent({ type: "remaining", value: +rem });
  if (!res.ok || !res.body) {
    let d: { error?: string; message?: string; retryAfter?: number } = {};
    try { d = await res.json(); } catch { /* not json */ }
    const kind = KNOWN.find((k) => k === d.error) ?? (res.status === 403 ? "forbidden_origin" : "http");
    throw new ApiError(kind, d.message || "Что-то пошло не так. Попробуйте ещё раз.", res.status, +(d.retryAfter ?? 0) || 0);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const handle = (block: string): void => {
    const payload = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!payload) return;
    let d: unknown;
    try { d = JSON.parse(payload); } catch { return; }
    if (d && typeof d === "object" && "type" in d) onEvent(d as StreamEvent);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m: RegExpMatchArray | null;
    while ((m = buf.match(/\r?\n\r?\n/))) {
      handle(buf.slice(0, m.index));
      buf = buf.slice((m.index ?? 0) + m[0].length);
    }
  }
  if (buf.trim()) handle(buf);
}
