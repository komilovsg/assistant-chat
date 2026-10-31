import { el } from "./dom";

/** Shimmering placeholder lines for a reply that has not produced a token yet. Styled via .skeleton in each stylesheet. */
export function createSkeleton(widths: number[] = [92, 78, 56]): HTMLElement {
  const s = el("div", "skeleton");
  s.setAttribute("aria-hidden", "true");
  for (const w of widths) {
    const l = el("i");
    l.style.width = w + "%";
    s.appendChild(l);
  }
  return s;
}
