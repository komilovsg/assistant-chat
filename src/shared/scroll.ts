import { el } from "./dom";
import { iconEl } from "./icons";

const PIN_PX = 80;

export interface StickyScroll {
  /** Call after content grew: follows the bottom only while pinned, otherwise flags new content. */
  follow(): void;
  /** Re-pin and jump to the bottom (instant, or smooth for the jump button). */
  pin(smooth?: boolean): void;
  isPinned(): boolean;
  /** Sticky wrapper holding the floating jump-to-bottom button; append it as the last child of the scroller. */
  jumpWrap: HTMLElement;
}

/** "Stick to bottom only if already at bottom" + floating jump button. Per-frame follow is an instant scrollTop write. */
export function createStickyScroll(scroller: HTMLElement, label: string): StickyScroll {
  let pinned = true, hasNew = false;
  const wrap = el("div", "jump-wrap");
  const btn = el("button", "jump");
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.hidden = true;
  btn.appendChild(iconEl("down"));
  btn.appendChild(el("i", "jump-dot"));
  wrap.appendChild(btn);

  const sync = (): void => {
    btn.hidden = pinned;
    btn.classList.toggle("has-new", hasNew && !pinned);
  };
  const atBottom = (): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < PIN_PX;
  const onUser = (): void => {
    pinned = atBottom();
    if (pinned) hasNew = false;
    sync();
  };
  scroller.addEventListener("scroll", onUser, { passive: true });
  scroller.addEventListener("touchmove", onUser, { passive: true });
  // wheel up un-pins immediately, before the scroll event, so a frame can't yank the user back down
  scroller.addEventListener("wheel", (e) => { if (e.deltaY < 0) { pinned = false; sync(); } else onUser(); }, { passive: true });

  const api: StickyScroll = {
    jumpWrap: wrap,
    isPinned: () => pinned,
    follow() {
      if (pinned) scroller.scrollTop = scroller.scrollHeight;
      else { hasNew = true; sync(); }
    },
    pin(smooth = false) {
      pinned = true; hasNew = false; sync();
      if (smooth) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
      else scroller.scrollTop = scroller.scrollHeight;
    },
  };
  btn.addEventListener("click", () => api.pin(true));
  return api;
}
