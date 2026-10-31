import { KEEP_MSGS, MAX_CTX, MAX_LAST, MAX_MSGS } from "./config";

export interface ChatMessage {
  role: "user" | "model";
  text: string;
}
export interface ChatBody {
  model: string;
  messages: ChatMessage[];
}
export interface UpstreamTurn {
  type: "user_input" | "model_output";
  content: { type: "text"; text: string }[];
}

/** Returns a Russian error message, or null if the body is a valid ChatBody. */
export function validate(b: unknown): string | null {
  if (!b || typeof b !== "object") return "Нужны поля model и messages.";
  const { model, messages: ms } = b as Record<string, unknown>;
  if (typeof model !== "string") return "Нужны поля model и messages.";
  if (!Array.isArray(ms) || ms.length < 1 || ms.length > MAX_MSGS) return `messages: от 1 до ${MAX_MSGS} сообщений.`;
  for (const m of ms as unknown[]) {
    const r = m as Partial<ChatMessage> | null;
    if (!r || typeof r !== "object" || (r.role !== "user" && r.role !== "model") || typeof r.text !== "string")
      return "Каждое сообщение: { role: user|model, text: string }.";
  }
  const last = ms[ms.length - 1] as ChatMessage;
  if (last.role !== "user" || !last.text.trim()) return "Последнее сообщение должно быть непустым сообщением пользователя.";
  if (last.text.length > MAX_LAST) return `Сообщение длиннее ${MAX_LAST} символов.`;
  return null;
}

/** Trims history to the last KEEP_MSGS / MAX_CTX chars, starting with a user turn. */
export function toInput(messages: ChatMessage[]): UpstreamTurn[] {
  const ms = messages.slice(-KEEP_MSGS);
  let total = ms.reduce((n, m) => n + m.text.length, 0);
  while (ms.length > 1 && (total > MAX_CTX || ms[0]!.role !== "user")) total -= ms.shift()!.text.length;
  return ms.map((m) => ({ type: m.role === "user" ? "user_input" : "model_output", content: [{ type: "text", text: m.text }] }));
}
