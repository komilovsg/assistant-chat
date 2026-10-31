export interface StoredMsg { role: "user" | "model"; text: string; model?: string; note?: string }
export interface Chat { id: string; title: string; ts: number; messages: StoredMsg[] }

const CKEY = "chats", MKEY = "model", MAX_CHATS = 20;
let mem: Chat[] = [];

export function loadChats(): Chat[] {
  try {
    const s: unknown = JSON.parse(localStorage.getItem(CKEY) ?? "null");
    if (Array.isArray(s)) return s.filter((c): c is Chat => !!c && typeof c.id === "string" && Array.isArray(c.messages));
  } catch { /* storage unavailable or corrupt */ }
  return mem;
}

/** Sorts newest first, trims to MAX_CHATS and persists; returns the stored list. */
export function saveChats(chats: Chat[]): Chat[] {
  const out = [...chats].sort((a, b) => b.ts - a.ts).slice(0, MAX_CHATS);
  mem = out;
  try { localStorage.setItem(CKEY, JSON.stringify(out)); } catch { /* quota / private mode */ }
  return out;
}

export function loadModel(): string {
  try { return localStorage.getItem(MKEY) ?? "auto"; } catch { return "auto"; }
}
export function saveModel(id: string): void {
  try { localStorage.setItem(MKEY, id); } catch { /* ignore */ }
}
