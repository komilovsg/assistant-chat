import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import { el, copyText } from "./dom";
import { iconEl } from "./icons";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("xml", xml); // also html
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);

DOMPurify.addHook("afterSanitizeAttributes", (n) => {
  if (n.tagName === "A") {
    n.setAttribute("target", "_blank");
    n.setAttribute("rel", "noopener noreferrer");
  }
});

export interface MdLabels { code: string; copy: string; copied: string; copyAria: string }
const RU: MdLabels = { code: "код", copy: "Копировать", copied: "Скопировано", copyAria: "Копировать код" };

/** Always DOMPurify.sanitize(marked.parse(...)). Returns a fragment; `final` enables syntax highlighting. */
export function renderMarkdown(text: string, final: boolean, labels: MdLabels = RU): DocumentFragment {
  const html = marked.parse(text, { gfm: true, breaks: false, async: false }) as string;
  const frag = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["img", "iframe", "script", "style", "form", "input", "button"],
    FORBID_ATTR: ["style"],
  });
  frag.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code") ?? pre;
    const m = (code.className || "").match(/language-([\w+#-]+)/);
    const wrap = el("div", "codeblock");
    const head = el("div", "code-head");
    head.appendChild(el("span", "", m ? m[1] : labels.code));
    const cb = el("button", "code-copy");
    cb.type = "button";
    cb.setAttribute("aria-label", labels.copyAria);
    cb.appendChild(iconEl("copy"));
    const lab = el("span", "", labels.copy);
    cb.appendChild(lab);
    cb.addEventListener("click", () => {
      copyText(code.textContent ?? "").then(() => {
        lab.textContent = labels.copied;
        const ok = iconEl("check", "icon check");
        cb.querySelector("svg")?.replaceWith(ok);
        setTimeout(() => { lab.textContent = labels.copy; if (ok.isConnected) ok.replaceWith(iconEl("copy")); }, 1500);
      }, () => { /* clipboard denied */ });
    });
    head.appendChild(cb);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
    if (final && m && hljs.getLanguage(m[1])) {
      try { hljs.highlightElement(code as HTMLElement); } catch { /* ignore */ }
    }
  });
  return frag;
}
