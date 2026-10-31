// Gemini Interactions API client: model attempt with first-token timeout, upstream SSE parsing, normalized SSE out.
import { FIRST_TOKEN_MS, TOTAL_MS, type Model } from "./config";
import type { UpstreamTurn } from "./validate";

const UPSTREAM = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** ok | dead (skip for everyone today) | skip (try next model) | config (stop: server misconfigured). */
export type AttemptKind = "ok" | "dead" | "skip" | "config";

export type UpstreamEvent = { type: "delta"; text: string } | { type: "end"; status: DoneStatus } | { type: "error" };
export type DoneStatus = "completed" | "incomplete";

/** Classifies a non-2xx upstream response. */
export function classifyUpstream(status: number, body: string): Exclude<AttemptKind, "ok"> {
  if (status === 401) return "config";
  if (status === 404 || status === 403) return "dead";
  if (status === 429 && /per.?day|daily/i.test(body)) return "dead";
  return "skip";
}

export interface Started {
  events: AsyncGenerator<UpstreamEvent>;
  first: UpstreamEvent[];
  ctrl: AbortController;
  timer: ReturnType<typeof setTimeout>;
}
export type Attempt = ({ kind: "ok"; status: 200 } & Started) | { kind: Exclude<AttemptKind, "ok">; status: number | string };

/** Calls one model and waits for its first text token. */
export async function tryModel(
  m: Model, input: UpstreamTurn[], apiKey: string, systemPrompt: string, clientSignal: AbortSignal | undefined,
): Promise<Attempt> {
  const ctrl = new AbortController();
  clientSignal?.addEventListener?.("abort", () => ctrl.abort());
  let timer = setTimeout(() => ctrl.abort(), FIRST_TOKEN_MS);
  try {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model: m.id,
        store: false,
        system_instruction: systemPrompt,
        generation_config: { max_output_tokens: 1024, temperature: 0.7, thinking_level: m.thinking },
        input,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      clearTimeout(timer);
      return { kind: classifyUpstream(res.status, text), status: res.status };
    }
    const events = upstreamEvents(res.body);
    const first: UpstreamEvent[] = [];
    for (;;) {
      const { value, done } = await events.next();
      if (done || value.type === "error") break;
      first.push(value);
      if (value.type === "delta" || value.type === "end") break;
    }
    if (!first.some((e) => e.type === "delta")) {
      ctrl.abort(); clearTimeout(timer);
      return { kind: "skip", status: "no_output" };
    }
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), TOTAL_MS);
    return { kind: "ok", status: 200, events, first, ctrl, timer };
  } catch {
    clearTimeout(timer);
    return { kind: "skip", status: ctrl.signal.aborted ? "timeout_or_abort" : "network" };
  }
}

const BROKE = "Ответ прервался. Попробуйте ещё раз.";

/** Writes the normalized SSE stream (meta → delta* → error? → done). See protocol in src/worker.ts. */
export async function pump({ events, first, ctrl, timer }: Started, model: string, w: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  const enc = new TextEncoder();
  const send = (o: unknown) => w.write(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
  let status: DoneStatus = "incomplete";
  try {
    await send({ type: "meta", model });
    const handle = async (e: UpstreamEvent) => {
      if (e.type === "delta") await send({ type: "delta", text: e.text });
      else if (e.type === "end") status = e.status;
      else { status = "incomplete"; await send({ type: "error", message: BROKE }); }
    };
    for (const e of first) await handle(e);
    for await (const e of events) await handle(e);
    await send({ type: "done", status });
    await w.close();
  } catch {
    // Client disconnected (write failed) or upstream broke: stop paying for tokens nobody reads.
    ctrl.abort();
    try { await send({ type: "error", message: BROKE }); await send({ type: "done", status: "incomplete" }); await w.close(); } catch { /* gone */ }
  } finally {
    clearTimeout(timer);
    console.log(JSON.stringify({ model, done: status }));
  }
}

/** Parses upstream SSE into normalized events. */
export async function* upstreamEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<UpstreamEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = (buf + value).replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let d: any;
      try { d = JSON.parse(data); } catch { continue; }
      if (d.error) yield { type: "error" };
      else if (d.event_type === "step.delta" && d.delta?.type === "text" && d.delta.text) yield { type: "delta", text: String(d.delta.text) };
      else if (d.interaction?.status && d.interaction.status !== "in_progress")
        yield { type: "end", status: d.interaction.status === "completed" ? "completed" : "incomplete" };
    }
  }
}
