import { ApiError, getConfig, streamChat, type ChatMsg } from "../shared/api";
import { el } from "../shared/dom";
import { iconEl } from "../shared/icons";
import { renderMarkdown, type MdLabels } from "../shared/markdown";
import { createStickyScroll } from "../shared/scroll";
import { createSkeleton } from "../shared/skeleton";
import { createTypewriter } from "../shared/typewriter";
import css from "./widget.css";

interface Strings {
  title: string; greeting: string; open: string; close: string; placeholder: string; send: string; stop: string; down: string;
  disclaimer: string; forbidden: string; network: string; stopped: string; empty: string; limit: string; left: string;
  wait: string; cut: string; broken: string; md: MdLabels;
}
const STR: Record<string, Strings> = {
  ru: {
    title: "Помощник", greeting: "Привет! Чем могу помочь?", open: "Открыть чат", close: "Закрыть чат", placeholder: "Напишите сообщение",
    send: "Отправить", stop: "Остановить", down: "Вниз", disclaimer: "ИИ может ошибаться. Проверяйте важную информацию.",
    forbidden: "Виджет не разрешён для этого сайта — добавьте домен в ALLOWED_ORIGINS",
    network: "Нет связи с сервером. Проверьте соединение (и ALLOWED_ORIGINS, если виджет встроен на другой сайт).",
    stopped: "Генерация остановлена.", empty: "Пустой ответ. Попробуйте ещё раз.", limit: "Дневной лимит исчерпан", left: "осталось",
    wait: "Подождите немного перед следующим сообщением.", cut: "ответ обрезан", broken: "ответ прерван",
    md: { code: "код", copy: "Копировать", copied: "Скопировано", copyAria: "Копировать код" },
  },
  en: {
    title: "Assistant", greeting: "Hi! How can I help?", open: "Open chat", close: "Close chat", placeholder: "Type a message",
    send: "Send", stop: "Stop", down: "Scroll down", disclaimer: "AI can make mistakes. Check important information.",
    forbidden: "The widget is not allowed on this site — add the domain to ALLOWED_ORIGINS",
    network: "Cannot reach the server. Check your connection (and ALLOWED_ORIGINS if embedded on another site).",
    stopped: "Generation stopped.", empty: "Empty reply. Please try again.", limit: "Daily limit reached", left: "left",
    wait: "Please wait a moment before the next message.", cut: "reply truncated", broken: "reply interrupted",
    md: { code: "code", copy: "Copy", copied: "Copied", copyAria: "Copy code" },
  },
};

const SKEY = "assistant_widget_chat", MAX_KEEP = 40;

function loadHistory(): ChatMsg[] {
  try {
    const s: unknown = JSON.parse(sessionStorage.getItem(SKEY) ?? "null");
    if (Array.isArray(s)) return s.filter((m): m is ChatMsg => !!m && (m.role === "user" || m.role === "model") && typeof m.text === "string");
  } catch { /* unavailable */ }
  return [];
}
function saveHistory(h: ChatMsg[]): void {
  try { sessionStorage.setItem(SKEY, JSON.stringify(h.slice(-MAX_KEEP))); } catch { /* ignore */ }
}

function mount(script: HTMLScriptElement | null): void {
  const ds = script?.dataset ?? {};
  const lang = ds.lang && STR[ds.lang] ? ds.lang : "ru";
  const t = STR[lang]!;
  let base = location.origin;
  try { if (script?.src) base = new URL(script.src, location.href).origin; } catch { /* keep */ }
  const title = ds.title || t.title;
  const side = ds.position === "left" ? "left" : "right";

  const host = el("div");
  host.id = "assistant-chat-host";
  const shadow = host.attachShadow({ mode: "open" });
  // constructed stylesheet: not blocked by a strict host CSP (style-src without 'unsafe-inline'); <style> as fallback
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = el("style");
    style.textContent = css;
    shadow.appendChild(style);
  }
  const root = el("div", "root " + side);
  if (ds.accent && /^#[0-9a-f]{3,8}$/i.test(ds.accent)) root.style.setProperty("--accent", ds.accent);

  // launcher
  const launcher = el("button", "launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-label", t.open);
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "panel");
  const icSpark = el("span", "ic ic-spark");
  icSpark.appendChild(iconEl("sparkles"));
  const icX = el("span", "ic ic-x");
  icX.appendChild(iconEl("x"));
  launcher.append(icSpark, icX, el("i", "dot"));

  // panel
  const panel = el("section", "panel");
  panel.id = "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", title);
  panel.inert = true;
  const header = el("header");
  const hic = el("span", "h-ic");
  hic.appendChild(iconEl("spark"));
  const closeBtn = el("button", "icon-btn");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", t.close);
  closeBtn.appendChild(iconEl("x"));
  header.append(hic, el("span", "title", title), closeBtn);
  const list = el("div", "list");
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "polite");
  const sticky = createStickyScroll(list, t.down);
  const form = el("form");
  form.autocomplete = "off";
  const input = el("textarea");
  input.rows = 1;
  input.placeholder = t.placeholder;
  input.setAttribute("aria-label", t.placeholder);
  const sendBtn = el("button", "send");
  sendBtn.type = "submit";
  sendBtn.disabled = true;
  sendBtn.setAttribute("aria-label", t.send);
  sendBtn.append(iconEl("up", "icon arrow"), el("span", "sq"));
  form.append(input, sendBtn);
  const foot = el("div", "foot", t.disclaimer);
  panel.append(header, list, form, foot);
  list.appendChild(sticky.jumpWrap);

  root.append(launcher, panel);
  shadow.append(root);

  // ---------- state ----------
  const history = loadHistory();
  let greeting = ds.greeting || "";
  let maxChars = 4000;
  let configLoaded = false;
  let remaining: number | null = null, locked = "", cooldownUntil = 0;
  let busy = false, userStopped = false, unread = false, isOpen = false;
  let ctrl: AbortController | null = null;

  const insert = (n: HTMLElement): void => { list.insertBefore(n, sticky.jumpWrap); };
  const sys = (text: string, info = false): HTMLElement => {
    const d = el("div", "sys" + (info ? " info" : ""), text);
    insert(d);
    sticky.pin();
    return d;
  };
  const modelBubble = (text: string, note = ""): HTMLElement => {
    const m = el("div", "msg model");
    const b = el("div", "body");
    b.appendChild(renderMarkdown(text, true, t.md));
    m.appendChild(b);
    if (note) m.appendChild(el("span", "note", note));
    return m;
  };
  function renderAll(): void {
    list.querySelectorAll(".msg,.sys").forEach((n) => n.remove());
    if (!history.length) {
      const g = greeting || t.greeting;
      insert(modelBubble(g));
    }
    for (const m of history) insert(m.role === "user" ? el("div", "msg user", m.text) : modelBubble(m.text));
    if (locked) sys(locked, true);
    sticky.pin();
  }
  function updateUI(): void {
    sendBtn.classList.toggle("busy", busy);
    sendBtn.setAttribute("aria-label", busy ? t.stop : t.send);
    const over = input.value.length > maxChars;
    sendBtn.disabled = busy ? false : !!locked || over || !input.value.trim();
    input.disabled = !!locked;
    input.placeholder = locked ? t.limit : t.placeholder;
    foot.textContent = remaining !== null && remaining <= 10 ? `${t.disclaimer} · ${t.left} ${Math.max(remaining, 0)}` : t.disclaimer;
  }
  function autoGrow(): void {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }
  function setUnread(v: boolean): void {
    unread = v;
    root.classList.toggle("unread", v);
  }

  // ---------- open / close ----------
  const focusables = (): HTMLElement[] =>
    Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled]):not([hidden]),textarea:not([disabled])"));
  function ensureConfig(): void {
    if (configLoaded) return;
    configLoaded = true;
    void getConfig(base).then((c) => {
      maxChars = c.maxInputChars;
      if (!ds.greeting && c.greeting) greeting = c.greeting;
      if (!history.length && !busy) renderAll();
      updateUI();
    });
  }
  function open(): void {
    if (isOpen) return;
    isOpen = true;
    root.classList.add("is-open");
    panel.inert = false;
    launcher.setAttribute("aria-expanded", "true");
    launcher.setAttribute("aria-label", t.close);
    setUnread(false);
    ensureConfig();
    sticky.pin();
    setTimeout(() => input.focus({ preventScroll: true }), 60);
  }
  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove("is-open");
    panel.inert = true;
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-label", t.open);
    launcher.focus({ preventScroll: true });
  }
  const toggle = (): void => (isOpen ? close() : open());
  launcher.addEventListener("click", toggle);
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen) { e.stopPropagation(); close(); } });
  shadow.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== "Tab" || !isOpen) return;
    const f = focusables();
    const first = f[0], last = f[f.length - 1];
    if (!first || !last) return;
    const active = shadow.activeElement;
    if (ke.shiftKey && active === first) { ke.preventDefault(); last.focus(); }
    else if (!ke.shiftKey && (active === last || !panel.contains(active))) { ke.preventDefault(); first.focus(); }
  });
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fit = (): void => {
      if (window.matchMedia("(max-width:639px)").matches) root.style.setProperty("--vvh", vv.height + "px");
      else root.style.removeProperty("--vvh");
    };
    vv.addEventListener("resize", fit);
    fit();
  }

  // ---------- sending ----------
  async function generate(): Promise<void> {
    busy = true; userStopped = false;
    updateUI();
    const bubble = el("div", "msg model");
    const body = el("div", "body streaming");
    body.appendChild(createSkeleton());
    bubble.appendChild(body);
    insert(bubble);
    sticky.pin();

    const tw = createTypewriter((visible) => {
      if (!body.classList.contains("reveal")) body.classList.add("reveal");
      body.replaceChildren(renderMarkdown(visible, false, t.md));
      sticky.follow();
    });
    const ac = new AbortController();
    ctrl = ac;
    let text = "", status = "completed", streamErr = false;
    const finish = (note: string): void => {
      history.push({ role: "model", text });
      saveHistory(history);
      const keep = !sticky.isPinned(), top = list.scrollTop;
      bubble.replaceWith(modelBubble(text, note));
      if (keep) list.scrollTop = top;
      if (!isOpen) setUnread(true);
    };
    const fail = (msg: string, restore = true): void => {
      tw.cancel();
      bubble.remove();
      if (restore) {
        const last = history.pop();
        saveHistory(history);
        if (last && !input.value) { input.value = last.text; autoGrow(); }
        renderAll();
      }
      sys(msg);
    };
    try {
      await streamChat(base, "auto", history, (ev) => {
        if (ev.type === "remaining") { remaining = ev.value; updateUI(); }
        else if (ev.type === "delta") { text += ev.text || ""; tw.push(text); }
        else if (ev.type === "error") streamErr = true;
        else if (ev.type === "done") status = ev.status || status;
      }, ac.signal);
      if (!text.trim()) { fail(t.empty); return; }
      await tw.drain();
      finish(streamErr ? t.broken : status === "incomplete" ? t.cut : "");
    } catch (e) {
      if (e instanceof ApiError && !text.trim()) {
        if (e.kind === "forbidden_origin") fail(t.forbidden);
        else if (e.kind === "network") fail(t.network);
        else if (e.kind === "daily_ip" || e.kind === "daily_global") { locked = e.message; fail(e.message); }
        else {
          if (e.kind === "rate_limited") cooldownUntil = Date.now() + (e.retryAfter || 30) * 1000;
          fail(e.message);
        }
      } else if (e instanceof DOMException && e.name === "AbortError" && userStopped) {
        tw.cancel();
        if (text.trim()) finish(t.stopped); else fail(t.stopped);
      } else if (text.trim()) { tw.cancel(); finish(t.broken); }
      else fail(t.network);
    } finally {
      busy = false; ctrl = null;
      updateUI();
      if (isOpen && !locked) input.focus({ preventScroll: true });
    }
  }
  function send(): void {
    const text = input.value.trim();
    if (!text || busy || locked || text.length > maxChars) return;
    if (Date.now() < cooldownUntil) { sys(t.wait, true); return; }
    history.push({ role: "user", text });
    saveHistory(history);
    input.value = ""; autoGrow();
    renderAll();
    void generate();
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) { userStopped = true; ctrl?.abort(); return; }
    send();
  });
  input.addEventListener("input", () => { autoGrow(); updateUI(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(); }
  });

  renderAll();
  updateUI();
  document.body.appendChild(host);
  pending.open = (): void => open();
  pending.close = (): void => close();
  pending.toggle = (): void => toggle();
  if (wantOpen || ds.open === "true") open();
}

// ---------- public API (usable before mount finishes) ----------
let wantOpen = false;
const pending = { open: (): void => { wantOpen = true; }, close: (): void => { wantOpen = false; }, toggle: (): void => { wantOpen = !wantOpen; } };
type Api = { open(): void; close(): void; toggle(): void };
const w = window as unknown as { AssistantChat?: Api };
if (!w.AssistantChat) {
  w.AssistantChat = { open: () => pending.open(), close: () => pending.close(), toggle: () => pending.toggle() };
  const script = document.currentScript instanceof HTMLScriptElement
    ? document.currentScript
    : document.querySelector<HTMLScriptElement>('script[src*="widget.js"]');
  if (document.body) mount(script);
  else document.addEventListener("DOMContentLoaded", () => mount(script), { once: true });
}
