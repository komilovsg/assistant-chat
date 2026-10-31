const APP_NAME = "Ассистент"; // product name: the one place to change it (also hardcoded in index.html <title>/meta)
(() => {
  "use strict";
  const MODELS = ["gemini-3-flash-preview", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];
  const MAX_INPUT_CHARS = 4000; // server limit for the last message
  document.title = APP_NAME + " — ИИ-чат";

  const $ = (id) => document.getElementById(id);
  const els = {
    app: document.querySelector(".app"), scroll: $("scroll"), empty: $("empty"), thread: $("thread"), form: $("form"), input: $("input"),
    counter: $("counter"), send: $("send"), cd: $("send-cd"), arrow: $("send-arrow"), newChat: $("new-chat"),
    sidebar: $("sidebar"), backdrop: $("backdrop"), menuBtn: $("menu-btn"), sideClose: $("side-close"),
    chatList: $("chat-list"), pickBtn: $("pick-btn"), pickLabel: $("pick-label"), menu: $("menu"), mic: $("mic"),
  };

  // ---------- helpers ----------
  const NS = "http://www.w3.org/2000/svg";
  function icon(id, cls) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("class", cls || "icon");
    const u = document.createElementNS(NS, "use");
    u.setAttribute("href", "#" + id);
    s.appendChild(u);
    return s;
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function iconBtn(id, label, onClick) {
    const b = el("button", "icon-btn");
    b.type = "button"; b.setAttribute("aria-label", label); b.title = label;
    b.appendChild(icon(id));
    b.addEventListener("click", () => onClick(b));
    return b;
  }

  // ---------- limits state (server owns the real limits; client only reflects them) ----------
  let remaining = null;     // from X-Remaining-Today
  let lockedMsg = "";       // set on daily_ip / daily_global
  let cooldownUntil = 0;    // light cooldown after 429 rate_limited
  let cdTimer = null;

  // ---------- chats storage ----------
  const CKEY = "chats", MKEY = "model", MAX_CHATS = 20;
  let memChats = [];
  function loadChats() {
    try {
      const s = JSON.parse(localStorage.getItem(CKEY));
      if (Array.isArray(s)) return s.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages));
    } catch (e) {}
    return memChats;
  }
  function saveChats() {
    chats.sort((a, b) => b.ts - a.ts);
    chats = chats.slice(0, MAX_CHATS);
    memChats = chats;
    try { localStorage.setItem(CKEY, JSON.stringify(chats)); } catch (e) {}
  }
  let chats = loadChats();
  let current = null; // active chat (saved on first finished reply)
  let busy = false, ctrl = null, userStopped = false;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- models ----------
  const prettyModel = (id) => String(id).replace(/^gemini-/, "").split("-")
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
  let selected = "auto";
  try { const m = localStorage.getItem(MKEY); if (m && (m === "auto" || MODELS.includes(m))) selected = m; } catch (e) {}
  function renderMenu() {
    els.menu.replaceChildren();
    const items = [{ id: "auto", name: "Авто", sub: "лучшая доступная" }, ...MODELS.map((id) => ({ id, name: prettyModel(id), sub: "" }))];
    for (const it of items) {
      const li = el("li"); li.setAttribute("role", "presentation");
      const b = el("button"); b.type = "button"; b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(it.id === selected));
      b.appendChild(el("span", "", it.name));
      if (it.sub) b.appendChild(el("small", "", it.sub));
      b.addEventListener("click", () => {
        selected = it.id;
        try { localStorage.setItem(MKEY, selected); } catch (e) {}
        closeMenu(); renderMenu();
      });
      li.appendChild(b); els.menu.appendChild(li);
    }
    els.pickLabel.textContent = (items.find((i) => i.id === selected) || items[0]).name;
  }
  function openMenu() { renderMenu(); els.menu.hidden = false; els.pickBtn.setAttribute("aria-expanded", "true"); }
  function closeMenu() { els.menu.hidden = true; els.pickBtn.setAttribute("aria-expanded", "false"); }
  els.pickBtn.addEventListener("click", () => (els.menu.hidden ? openMenu() : closeMenu()));
  document.addEventListener("click", (e) => { if (!els.menu.hidden && !e.target.closest(".picker")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); closeDrawer(); } });

  // ---------- markdown: ALWAYS DOMPurify.sanitize(marked.parse(...)) ----------
  DOMPurify.addHook("afterSanitizeAttributes", (n) => {
    if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); }
  });
  function mdFragment(text) {
    return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }), {
      RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe"], FORBID_ATTR: ["style"],
    });
  }
  function copyText(text) {
    try { return navigator.clipboard.writeText(text); } catch (e) { return Promise.reject(e); }
  }
  // swap icon for an animated check mark, then restore
  function flash(btn, id) {
    const old = btn.querySelector("svg");
    const cls = old.getAttribute("class");
    const ok = icon("i-check", cls + " check");
    old.replaceWith(ok);
    setTimeout(() => { if (ok.isConnected) ok.replaceWith(icon(id, cls)); }, 1600);
  }
  function decorate(root, final) {
    root.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code") || pre;
      const m = (code.className || "").match(/language-([\w+#-]+)/);
      const wrap = el("div", "codeblock");
      const head = el("div", "code-head");
      head.appendChild(el("span", "", m ? m[1] : "код"));
      const cb = el("button", "code-copy"); cb.type = "button"; cb.setAttribute("aria-label", "Копировать код");
      cb.appendChild(icon("i-copy")); cb.appendChild(el("span", "", "Копировать"));
      cb.addEventListener("click", () => copyText(code.textContent).then(() => {
        const s = cb.querySelector("span"); s.textContent = "Скопировано";
        const ic = cb.querySelector("svg"); const ok = icon("i-check", "icon check"); ic.replaceWith(ok);
        setTimeout(() => { s.textContent = "Копировать"; if (ok.isConnected) ok.replaceWith(icon("i-copy")); }, 1500);
      }, () => {}));
      head.appendChild(cb);
      pre.replaceWith(wrap); wrap.appendChild(head); wrap.appendChild(pre);
      if (final && window.hljs) { try { hljs.highlightElement(code); } catch (e) {} }
    });
  }
  function renderBody(body, text, final) {
    body.replaceChildren(mdFragment(text));
    decorate(body, final);
  }

  // ---------- thread rendering ----------
  const nearBottom = () => els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 120;
  const scrollDown = () => { els.scroll.scrollTop = els.scroll.scrollHeight; };

  function modelNode() {
    const row = el("div", "msg model");
    const av = icon("i-spark", "avatar"); row.appendChild(av);
    const col = el("div", "model-col"); row.appendChild(col);
    const body = el("div", "body"); col.appendChild(body);
    return { row, col, body, av };
  }
  function addActions(node, m, isLast) {
    const bar = el("div", "actions");
    bar.appendChild(iconBtn("i-copy", "Копировать", (b) => copyText(m.text).then(() => flash(b, "i-copy"), () => {})));
    if (isLast) bar.appendChild(iconBtn("i-redo", "Повторить", (b) => { b.querySelector("svg").classList.add("spin-once"); regenerate(); }));
    if (m.model) bar.appendChild(el("span", "caption", m.model));
    node.col.appendChild(bar);
  }
  function renderMessage(m, isLast) {
    if (m.role === "user") { const d = el("div", "msg user"); d.textContent = m.text; els.thread.appendChild(d); return; }
    const n = modelNode();
    renderBody(n.body, m.text, true);
    if (m.note) n.col.appendChild(el("span", "note", m.note));
    addActions(n, m, isLast);
    els.thread.appendChild(n.row);
  }
  function renderChat() {
    els.thread.replaceChildren();
    const msgs = current ? current.messages : [];
    msgs.forEach((m, i) => renderMessage(m, i === msgs.length - 1));
    updateUI(); scrollDown();
  }
  function sysMsg(text, info) {
    const d = el("div", "sys" + (info ? " info" : ""), text);
    els.thread.appendChild(d); scrollDown(); return d;
  }

  // ---------- sidebar ----------
  const mobile = () => window.matchMedia("(max-width:767px)").matches;
  function openDrawer() { els.sidebar.classList.add("open"); els.backdrop.classList.add("show"); }
  function closeDrawer() { els.sidebar.classList.remove("open"); els.backdrop.classList.remove("show"); }
  els.menuBtn.addEventListener("click", () => {
    if (mobile()) openDrawer(); else els.sidebar.classList.toggle("collapsed");
  });
  els.sideClose.addEventListener("click", () => { if (mobile()) closeDrawer(); else els.sidebar.classList.add("collapsed"); });
  els.backdrop.addEventListener("click", closeDrawer);

  function renderSidebar() {
    els.chatList.replaceChildren();
    if (!chats.length) { els.chatList.appendChild(el("li", "side-empty", "Пока пусто")); return; }
    for (const c of chats) {
      const li = el("li", "chat-item" + (current && current.id === c.id ? " active" : ""));
      const open = el("button", "chat-open", c.title); open.type = "button"; open.title = c.title;
      open.addEventListener("click", () => openChat(c.id));
      const del = iconBtn("i-trash", "Удалить чат", () => deleteChat(c.id));
      del.classList.add("chat-del");
      li.appendChild(open); li.appendChild(del); els.chatList.appendChild(li);
    }
  }
  function openChat(id) {
    if (busy) return;
    const c = chats.find((x) => x.id === id);
    if (!c) return;
    current = c; renderChat(); renderSidebar(); closeDrawer();
  }
  function newChat() {
    if (busy) return;
    current = null; renderChat(); renderSidebar(); closeDrawer(); els.input.focus();
  }
  function deleteChat(id) {
    if (busy && current && current.id === id) return;
    chats = chats.filter((c) => c.id !== id);
    saveChats();
    if (current && current.id === id) current = null;
    renderChat(); renderSidebar();
  }
  els.newChat.addEventListener("click", newChat);

  function persist() {
    if (!current || !current.messages.length) return;
    current.ts = Date.now();
    if (!chats.includes(current)) chats.push(current);
    saveChats(); renderSidebar();
  }

  // ---------- composer UI ----------
  function autoGrow() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 144) + "px";
  }
  function updateUI() {
    const len = els.input.value.length;
    const over = len > MAX_INPUT_CHARS;
    const parts = [];
    if (len >= MAX_INPUT_CHARS * 0.8) parts.push(`${len}/${MAX_INPUT_CHARS}`);
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
    if (cooling) els.cd.textContent = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (busy) { els.send.setAttribute("aria-label", "Остановить"); els.send.disabled = false; }
    else {
      els.send.setAttribute("aria-label", "Отправить");
      els.send.disabled = capped || cooling || over || !els.input.value.trim();
    }
    els.empty.hidden = !!(current && current.messages.length > 0);
  }
  function startCooldown(ms) {
    cooldownUntil = Date.now() + ms;
    tickCooldown();
  }
  function tickCooldown() {
    clearInterval(cdTimer);
    cdTimer = setInterval(() => { if (Date.now() >= cooldownUntil) clearInterval(cdTimer); updateUI(); }, 250);
  }
  function lockComposer(msg) {
    lockedMsg = msg;
    if (!els.thread.querySelector(".daily")) sysMsg(msg, true).classList.add("daily");
    updateUI();
  }

  // ---------- API ----------
  // The ONLY place that talks to the network: POST /api/chat (same origin, SSE).
  // Calls onEvent({type:"meta",model}) | ({type:"delta",text}) | ({type:"error",message}) | ({type:"done",status}).
  // Resolves {ok:true} or {ok:false,status,data} for a non-2xx response. Rejects on network failure / abort.
  async function streamChat(model, messages, onEvent, signal) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, text: m.text })) }),
      signal,
    });
    const rem = res.headers.get("X-Remaining-Today");
    if (rem !== null && rem !== "" && !isNaN(+rem)) { remaining = +rem; updateUI(); }
    if (!res.ok) {
      let data = null; try { data = await res.json(); } catch (e) {}
      return { ok: false, status: res.status, data };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const handle = (block) => {
      const payload = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!payload) return;
      let d; try { d = JSON.parse(payload); } catch (e) { return; }
      if (d && d.type) onEvent(d);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let m;
      while ((m = buf.match(/\r?\n\r?\n/))) { handle(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length); }
    }
    if (buf.trim()) handle(buf);
    return { ok: true };
  }

  // ---------- generation ----------
  async function generate(restoreReply) {
    busy = true; userStopped = false;
    updateUI();

    const node = modelNode();
    node.body.classList.add("streaming");
    const think = el("div", "thinking"); for (let i = 0; i < 3; i++) think.appendChild(el("i"));
    node.body.appendChild(think);
    node.av.classList.add("spin");
    els.thread.appendChild(node.row);
    scrollDown();

    const userMsg = current.messages[current.messages.length - 1];
    // The server may deliver the whole answer in one burst, so reveal text smoothly (catch-up typewriter).
    let raf = 0, shown = 0, latest = "", drainResolve = null;
    const tick = () => {
      raf = 0;
      if (userStopped) shown = latest.length;
      if (shown < latest.length) {
        shown = Math.min(latest.length, shown + Math.max(2, Math.ceil((latest.length - shown) / 25)));
        const stick = nearBottom();
        renderBody(node.body, latest.slice(0, shown), false);
        if (stick) scrollDown();
      }
      if (shown < latest.length) raf = requestAnimationFrame(tick);
      else if (drainResolve) { const r = drainResolve; drainResolve = null; r(); }
    };
    const onText = (txt) => { latest = txt; if (!raf) raf = requestAnimationFrame(tick); };
    const drain = () => (shown >= latest.length ? Promise.resolve() : new Promise((r) => { drainResolve = r; if (!raf) raf = requestAnimationFrame(tick); }));
    const fail = (msg) => {
      cancelAnimationFrame(raf); raf = 0;
      node.row.remove();
      if (restoreReply) current.messages.push(restoreReply);
      else { current.messages.pop(); if (!els.input.value) { els.input.value = userMsg.text; autoGrow(); } }
      if (!current.messages.length) current = null;
      renderChat(); renderSidebar();
      sysMsg(msg);
    };

    const ac = new AbortController();
    ctrl = ac;
    let text = "", actualModel = selected, status = "completed", streamErr = null;
    try {
      const r = await streamChat(selected, current.messages, (ev) => {
        if (ev.type === "meta") actualModel = ev.model || actualModel;
        else if (ev.type === "delta") { text += ev.text || ""; onText(text); }
        else if (ev.type === "error") streamErr = ev.message || "Ответ прерван.";
        else if (ev.type === "done") status = ev.status || status;
      }, ac.signal);

      if (!r.ok) {
        const d = r.data || {};
        const msg = d.message || "Что-то пошло не так. Попробуйте ещё раз.";
        if (d.error === "daily_ip" || d.error === "daily_global") { fail(msg); lockComposer(msg); }
        else {
          if (d.error === "rate_limited") startCooldown((+d.retryAfter || 60) * 1000);
          fail(msg);
        }
        return;
      }
      if (!text.trim()) { fail(streamErr || "Пустой ответ. Попробуйте ещё раз."); return; }
      await drain();
      const note = streamErr ? "ответ прерван" : (status === "incomplete" ? "ответ обрезан" : "");
      current.messages.push({ role: "model", text, model: prettyModel(actualModel), note });
      persist();
      renderChat();
    } catch (e) {
      if (e && e.name === "AbortError" && userStopped) {
        cancelAnimationFrame(raf); raf = 0;
        if (text.trim()) {
          current.messages.push({ role: "model", text, model: prettyModel(actualModel), note: "остановлено" });
          persist(); renderChat();
        } else fail("Генерация остановлена.");
      } else if (text.trim()) {
        cancelAnimationFrame(raf); raf = 0;
        current.messages.push({ role: "model", text, model: prettyModel(actualModel), note: "ответ прерван" });
        persist(); renderChat();
      } else {
        console.error("chat request failed", e);
        fail("Ошибка сети. Проверьте соединение и попробуйте ещё раз.");
      }
    } finally {
      busy = false; ctrl = null;
      updateUI(); renderMenu();
    }
  }

  function send(text) {
    text = text.trim();
    if (!text || busy || lockedMsg || text.length > MAX_INPUT_CHARS) return;
    if (Date.now() < cooldownUntil) return;
    if (!current) current = { id: uid(), title: text.length > 40 ? text.slice(0, 40).trimEnd() : text, ts: Date.now(), messages: [] };
    current.messages.push({ role: "user", text });
    els.input.value = ""; autoGrow();
    renderChat();
    generate(null);
  }
  function regenerate() {
    if (busy || !current || lockedMsg) return;
    if (Date.now() < cooldownUntil) {
      const old = els.thread.querySelector(".sys.wait"); if (old) old.remove();
      sysMsg("Подождите несколько секунд перед повтором.", true).classList.add("wait");
      return;
    }
    const last = current.messages[current.messages.length - 1];
    if (!last || last.role !== "model") return;
    current.messages.pop();
    renderChat();
    generate(last);
  }

  // ---------- speech ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    els.mic.hidden = false;
    let rec = null, base = "";
    els.mic.addEventListener("click", () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = "ru-RU"; rec.interimResults = true; rec.continuous = false;
      base = els.input.value ? els.input.value.replace(/\s*$/, " ") : "";
      rec.onresult = (e) => {
        let s = ""; for (const r of e.results) s += r[0].transcript;
        els.input.value = (base + s).slice(0, MAX_INPUT_CHARS + 50); autoGrow(); updateUI();
      };
      const end = () => { rec = null; els.mic.classList.remove("on"); els.mic.setAttribute("aria-label", "Голосовой ввод"); els.input.focus(); };
      rec.onend = end; rec.onerror = end;
      try { rec.start(); els.mic.classList.add("on"); els.mic.setAttribute("aria-label", "Остановить запись"); } catch (e) { rec = null; }
    });
  }

  // ---------- wiring ----------
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) { userStopped = true; if (ctrl) ctrl.abort(); return; }
    send(els.input.value);
  });
  els.input.addEventListener("input", () => { autoGrow(); updateUI(); });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy && !els.send.disabled) send(els.input.value); }
  });
  window.matchMedia("(max-width:767px)").addEventListener("change", closeDrawer);
  // keep composer above the on-screen keyboard (iOS)
  if (window.visualViewport) {
    const fit = () => { els.app.style.height = mobile() ? window.visualViewport.height + "px" : ""; if (mobile()) window.scrollTo(0, 0); };
    window.visualViewport.addEventListener("resize", fit); fit();
  }

  // about modal
  const about = $("about");
  const showAbout = (v) => { about.hidden = !v; if (v) $("about-close").focus(); else $("about-open").focus(); };
  $("about-open").addEventListener("click", () => { closeDrawer(); showAbout(true); });
  $("about-close").addEventListener("click", () => showAbout(false));
  $("about-bd").addEventListener("click", () => showAbout(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !about.hidden) showAbout(false); });
  $("brand").textContent = APP_NAME;

  renderMenu(); renderSidebar(); renderChat();
  if (cooldownUntil > Date.now()) tickCooldown();
  updateUI();
})();
