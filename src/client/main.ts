import { ApiError, DEFAULT_CONFIG, getConfig, streamChat, type AppConfig } from "../shared/api";
import { el, copyText } from "../shared/dom";
import { iconEl, type IconName } from "../shared/icons";
import { renderMarkdown } from "../shared/markdown";
import { createTypewriter } from "../shared/typewriter";
import { createStickyScroll } from "../shared/scroll";
import { createSkeleton } from "../shared/skeleton";
import { loadChats, loadModel, saveChats, saveModel, type Chat, type StoredMsg } from "./store";

const BASE = ""; // same origin
let cfg: AppConfig = DEFAULT_CONFIG;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const n = document.getElementById(id);
  if (!n) throw new Error("missing #" + id);
  return n as T;
};
const els = {
  app: document.querySelector<HTMLElement>(".app")!,
  scroll: $("scroll"), empty: $("empty"), thread: $("thread"), form: $<HTMLFormElement>("form"),
  input: $<HTMLTextAreaElement>("input"), counter: $("counter"), send: $<HTMLButtonElement>("send"),
  cd: $("send-cd"), arrow: $("send-arrow"), newChat: $("new-chat"), sidebar: $("sidebar"), backdrop: $("backdrop"),
  menuBtn: $("menu-btn"), sideClose: $("side-close"), chatList: $("chat-list"), pickBtn: $("pick-btn"),
  pickLabel: $("pick-label"), menu: $("menu"), mic: $("mic"),
};

function iconBtn(name: IconName, label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = el("button", "icon-btn");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.appendChild(iconEl(name));
  b.addEventListener("click", () => onClick(b));
  return b;
}

// ---------- limits state (server owns the real limits; client only reflects them) ----------
let remaining: number | null = null; // from X-Remaining-Today
let lockedMsg = "";                  // set on daily_ip / daily_global
let cooldownUntil = 0;               // light cooldown after 429 rate_limited
let cdTimer: ReturnType<typeof setInterval> | undefined;

// ---------- state ----------
let chats: Chat[] = loadChats();
let current: Chat | null = null; // active chat (saved on first finished reply)
let busy = false, userStopped = false;
let ctrl: AbortController | null = null;
const uid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- models ----------
const prettyModel = (id: string): string =>
  id.replace(/^gemini-/, "").split("-").map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
const modelLabel = (id: string): string => cfg.models.find((m) => m.id === id)?.label ?? prettyModel(id);
let selected = loadModel();
let loading = true; // /api/config pending: skeletons in sidebar + picker

function renderMenu(): void {
  els.pickBtn.toggleAttribute("disabled", loading);
  els.pickLabel.classList.toggle("sk", loading);
  if (loading) { els.pickLabel.textContent = ""; return; }
  if (selected !== "auto" && !cfg.models.some((m) => m.id === selected)) selected = "auto";
  els.menu.replaceChildren();
  const items = [{ id: "auto", name: "Авто", sub: "лучшая доступная" }, ...cfg.models.map((m) => ({ id: m.id, name: m.label, sub: "" }))];
  for (const it of items) {
    const li = el("li");
    li.setAttribute("role", "presentation");
    const b = el("button");
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(it.id === selected));
    b.appendChild(el("span", "", it.name));
    if (it.sub) b.appendChild(el("small", "", it.sub));
    b.addEventListener("click", () => { selected = it.id; saveModel(selected); closeMenu(); renderMenu(); });
    li.appendChild(b);
    els.menu.appendChild(li);
  }
  els.pickLabel.textContent = (items.find((i) => i.id === selected) ?? items[0])!.name;
}
function openMenu(): void { renderMenu(); els.menu.hidden = false; els.pickBtn.setAttribute("aria-expanded", "true"); }
function closeMenu(): void { els.menu.hidden = true; els.pickBtn.setAttribute("aria-expanded", "false"); }
els.pickBtn.addEventListener("click", () => (els.menu.hidden ? openMenu() : closeMenu()));
document.addEventListener("click", (e) => { if (!els.menu.hidden && !(e.target as Element).closest(".picker")) closeMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); closeDrawer(); } });

// ---------- message decorations ----------
function flash(btn: HTMLButtonElement, name: IconName): void {
  const old = btn.querySelector("svg");
  if (!old) return;
  const cls = old.getAttribute("class") ?? "icon";
  const ok = iconEl("check", cls + " check");
  old.replaceWith(ok);
  setTimeout(() => { if (ok.isConnected) ok.replaceWith(iconEl(name, cls)); }, 1600);
}
function renderBody(body: HTMLElement, text: string, final: boolean): void {
  body.replaceChildren(renderMarkdown(text, final));
}

// ---------- thread rendering ----------
const sticky = createStickyScroll(els.scroll, "Вниз");
els.scroll.appendChild(sticky.jumpWrap);
const scrollDown = (): void => sticky.pin();

interface ModelNode { row: HTMLElement; col: HTMLElement; body: HTMLElement; av: SVGElement }
function modelNode(): ModelNode {
  const row = el("div", "msg model");
  const av = iconEl("spark", "avatar");
  row.appendChild(av);
  const col = el("div", "model-col");
  row.appendChild(col);
  const body = el("div", "body");
  col.appendChild(body);
  return { row, col, body, av };
}
function addActions(node: ModelNode, m: StoredMsg, isLast: boolean): void {
  const bar = el("div", "actions");
  bar.appendChild(iconBtn("copy", "Копировать", (b) => copyText(m.text).then(() => flash(b, "copy"), () => { /* denied */ })));
  if (isLast) bar.appendChild(iconBtn("redo", "Повторить", (b) => { b.querySelector("svg")?.classList.add("spin-once"); regenerate(); }));
  if (m.model) bar.appendChild(el("span", "caption", m.model));
  node.col.appendChild(bar);
}
function renderMessage(m: StoredMsg, isLast: boolean): void {
  if (m.role === "user") { els.thread.appendChild(el("div", "msg user", m.text)); return; }
  const n = modelNode();
  renderBody(n.body, m.text, true);
  if (m.note) n.col.appendChild(el("span", "note", m.note));
  addActions(n, m, isLast);
  els.thread.appendChild(n.row);
}
function renderChat(keepScroll = false): void {
  const top = els.scroll.scrollTop;
  els.thread.replaceChildren();
  const msgs = current ? current.messages : [];
  msgs.forEach((m, i) => renderMessage(m, i === msgs.length - 1));
  updateUI();
  if (keepScroll) els.scroll.scrollTop = top; else scrollDown();
}
function sysMsg(text: string, info = false): HTMLElement {
  const d = el("div", "sys" + (info ? " info" : ""), text);
  els.thread.appendChild(d);
  scrollDown();
  return d;
}

// ---------- sidebar ----------
const mobileMq = window.matchMedia("(max-width:767px)");
const mobile = (): boolean => mobileMq.matches;
function openDrawer(): void { els.sidebar.classList.add("open"); els.backdrop.classList.add("show"); }
function closeDrawer(): void { els.sidebar.classList.remove("open"); els.backdrop.classList.remove("show"); }
els.menuBtn.addEventListener("click", () => { if (mobile()) openDrawer(); else els.sidebar.classList.toggle("collapsed"); });
els.sideClose.addEventListener("click", () => { if (mobile()) closeDrawer(); else els.sidebar.classList.add("collapsed"); });
els.backdrop.addEventListener("click", closeDrawer);

function renderSidebar(): void {
  els.chatList.replaceChildren();
  if (loading) {
    for (const w of [80, 62, 71, 54]) { const li = el("li", "chat-sk"); const i = el("i"); i.style.width = w + "%"; li.appendChild(i); els.chatList.appendChild(li); }
    return;
  }
  if (!chats.length) { els.chatList.appendChild(el("li", "side-empty", "Пока пусто")); return; }
  for (const c of chats) {
    const li = el("li", "chat-item" + (current && current.id === c.id ? " active" : ""));
    const open = el("button", "chat-open", c.title);
    open.type = "button";
    open.title = c.title;
    open.addEventListener("click", () => openChat(c.id));
    const del = iconBtn("trash", "Удалить чат", () => deleteChat(c.id));
    del.classList.add("chat-del");
    li.append(open, del);
    els.chatList.appendChild(li);
  }
}
function openChat(id: string): void {
  if (busy) return;
  const c = chats.find((x) => x.id === id);
  if (!c) return;
  current = c;
  renderChat(); renderSidebar(); closeDrawer();
}
function newChat(): void {
  if (busy) return;
  current = null;
  renderChat(); renderSidebar(); closeDrawer(); els.input.focus();
}
function deleteChat(id: string): void {
  if (busy && current && current.id === id) return;
  chats = saveChats(chats.filter((c) => c.id !== id));
  if (current && current.id === id) current = null;
  renderChat(); renderSidebar();
}
els.newChat.addEventListener("click", newChat);

function persist(): void {
  if (!current || !current.messages.length) return;
  current.ts = Date.now();
  if (!chats.includes(current)) chats.push(current);
  chats = saveChats(chats);
  renderSidebar();
}

// ---------- composer UI ----------
function autoGrow(): void {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 144) + "px";
}
function updateUI(): void {
  const max = cfg.maxInputChars;
  const len = els.input.value.length;
  const over = len > max;
  const parts: string[] = [];
  if (len >= max * 0.8) parts.push(`${len}/${max}`);
  if (remaining !== null && remaining <= 10) parts.push(`осталось ${Math.max(remaining, 0)}`);
  els.counter.textContent = parts.join(" · ");
  els.counter.classList.toggle("over", over);
  const capped = !!lockedMsg;
  els.input.disabled = capped;
  els.input.placeholder = capped ? "Дневной лимит исчерпан" : "Спросите что угодно";
  const cooling = cooldownUntil - Date.now() > 0 && !busy;
  els.cd.hidden = !cooling;
  els.arrow.style.display = cooling ? "none" : "";
  els.send.classList.toggle("cool", cooling);
  els.send.classList.toggle("busy", busy);
  if (cooling) els.cd.textContent = String(Math.ceil((cooldownUntil - Date.now()) / 1000));
  if (busy) { els.send.setAttribute("aria-label", "Остановить"); els.send.disabled = false; }
  else {
    els.send.setAttribute("aria-label", "Отправить");
    els.send.disabled = capped || cooling || over || !els.input.value.trim();
  }
  els.empty.hidden = !!(current && current.messages.length > 0);
}
function tickCooldown(): void {
  clearInterval(cdTimer);
  cdTimer = setInterval(() => { if (Date.now() >= cooldownUntil) clearInterval(cdTimer); updateUI(); }, 250);
}
function startCooldown(ms: number): void { cooldownUntil = Date.now() + ms; tickCooldown(); }
function lockComposer(msg: string): void {
  lockedMsg = msg;
  if (!els.thread.querySelector(".daily")) sysMsg(msg, true).classList.add("daily");
  updateUI();
}

// ---------- generation ----------
async function generate(restoreReply: StoredMsg | null): Promise<void> {
  const chat = current;
  if (!chat) return;
  busy = true; userStopped = false;
  updateUI();

  const node = modelNode();
  node.body.classList.add("streaming");
  node.body.appendChild(createSkeleton());
  node.av.classList.add("spin");
  els.thread.appendChild(node.row);
  scrollDown();

  const userMsg = chat.messages[chat.messages.length - 1]!;
  const tw = createTypewriter((visible) => {
    if (!node.body.classList.contains("reveal")) node.body.classList.add("reveal"); // crossfade skeleton -> text
    renderBody(node.body, visible, false);
    sticky.follow();
  });
  const fail = (msg: string): void => {
    tw.cancel();
    node.row.remove();
    if (restoreReply) chat.messages.push(restoreReply);
    else {
      chat.messages.pop();
      if (!els.input.value) { els.input.value = userMsg.text; autoGrow(); }
    }
    if (!chat.messages.length) current = null;
    renderChat(); renderSidebar();
    sysMsg(msg);
  };

  const ac = new AbortController();
  ctrl = ac;
  let text = "", actualModel = selected, status = "completed", streamErr: string | null = null;
  const finish = (note: string): void => {
    chat.messages.push({ role: "model", text, model: modelLabel(actualModel), note });
    const keep = !sticky.isPinned();
    persist(); renderChat(keep);
  };
  try {
    await streamChat(BASE, selected, chat.messages, (ev) => {
      if (ev.type === "remaining") { remaining = ev.value; updateUI(); }
      else if (ev.type === "meta") actualModel = ev.model || actualModel;
      else if (ev.type === "delta") { text += ev.text || ""; tw.push(text); }
      else if (ev.type === "error") streamErr = ev.message || "Ответ прерван.";
      else if (ev.type === "done") status = ev.status || status;
    }, ac.signal);

    if (!text.trim()) { fail(streamErr || "Пустой ответ. Попробуйте ещё раз."); return; }
    await tw.drain();
    finish(streamErr ? "ответ прерван" : status === "incomplete" ? "ответ обрезан" : "");
  } catch (e) {
    if (e instanceof ApiError && !text.trim()) {
      if (e.kind === "daily_ip" || e.kind === "daily_global") { fail(e.message); lockComposer(e.message); }
      else {
        if (e.kind === "rate_limited") startCooldown((e.retryAfter || 60) * 1000);
        fail(e.message);
      }
    } else if (e instanceof DOMException && e.name === "AbortError" && userStopped) {
      tw.cancel();
      if (text.trim()) finish("остановлено"); else fail("Генерация остановлена.");
    } else if (text.trim()) {
      tw.cancel();
      finish("ответ прерван");
    } else {
      console.error("chat request failed", e);
      fail("Ошибка сети. Проверьте соединение и попробуйте ещё раз.");
    }
  } finally {
    busy = false; ctrl = null;
    updateUI(); renderMenu();
  }
}

function send(raw: string): void {
  const text = raw.trim();
  if (!text || busy || lockedMsg || text.length > cfg.maxInputChars) return;
  if (Date.now() < cooldownUntil) return;
  if (!current) current = { id: uid(), title: text.length > 40 ? text.slice(0, 40).trimEnd() : text, ts: Date.now(), messages: [] };
  current.messages.push({ role: "user", text });
  els.input.value = ""; autoGrow();
  renderChat(); // re-pins
  void generate(null);
}
function regenerate(): void {
  if (busy || !current || lockedMsg) return;
  if (Date.now() < cooldownUntil) {
    els.thread.querySelector(".sys.wait")?.remove();
    sysMsg("Подождите несколько секунд перед повтором.", true).classList.add("wait");
    return;
  }
  const last = current.messages[current.messages.length - 1];
  if (!last || last.role !== "model") return;
  current.messages.pop();
  renderChat();
  void generate(last);
}

// ---------- speech ----------
interface SpeechRec {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null;
  start(): void; stop(): void;
}
const SR = (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec })
  .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
if (SR) {
  els.mic.hidden = false;
  let rec: SpeechRec | null = null, base = "";
  els.mic.addEventListener("click", () => {
    if (rec) { rec.stop(); return; }
    const r = new SR();
    rec = r;
    r.lang = "ru-RU"; r.interimResults = true; r.continuous = false;
    base = els.input.value ? els.input.value.replace(/\s*$/, " ") : "";
    r.onresult = (e) => {
      let s = "";
      for (const res of Array.from(e.results)) s += res[0]?.transcript ?? "";
      els.input.value = (base + s).slice(0, cfg.maxInputChars + 50); autoGrow(); updateUI();
    };
    const end = (): void => { rec = null; els.mic.classList.remove("on"); els.mic.setAttribute("aria-label", "Голосовой ввод"); els.input.focus(); };
    r.onend = end; r.onerror = end;
    try { r.start(); els.mic.classList.add("on"); els.mic.setAttribute("aria-label", "Остановить запись"); } catch { rec = null; }
  });
}

// ---------- wiring ----------
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { userStopped = true; ctrl?.abort(); return; }
  send(els.input.value);
});
els.input.addEventListener("input", () => { autoGrow(); updateUI(); });
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy && !els.send.disabled) send(els.input.value); }
});
mobileMq.addEventListener("change", closeDrawer);
// keep composer above the on-screen keyboard (iOS)
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = (): void => { els.app.style.height = mobile() ? vv.height + "px" : ""; if (mobile()) window.scrollTo(0, 0); };
  vv.addEventListener("resize", fit);
  fit();
}

// about modal
const about = $("about");
const showAbout = (v: boolean): void => { about.hidden = !v; (v ? $("about-close") : $("about-open")).focus(); };
$("about-open").addEventListener("click", () => { closeDrawer(); showAbout(true); });
$("about-close").addEventListener("click", () => showAbout(false));
$("about-bd").addEventListener("click", () => showAbout(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !about.hidden) showAbout(false); });

function applyConfig(c: AppConfig): void {
  cfg = c;
  loading = false;
  document.title = c.appName + " — ИИ-чат";
  $("brand").textContent = c.appName;
  renderMenu(); renderSidebar(); updateUI();
}

renderMenu(); renderSidebar(); renderChat();
if (cooldownUntil > Date.now()) tickCooldown();
updateUI();
void getConfig(BASE).then(applyConfig);
