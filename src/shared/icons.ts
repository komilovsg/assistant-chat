/*
 * Inline icons. Paths from Lucide (https://lucide.dev), ISC License.
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
 */
export type IconName = "copy" | "check" | "redo" | "trash" | "spark" | "sparkles" | "x" | "up" | "down";

const SPARK = "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z";

const PATHS: Record<IconName, string> = {
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path pathLength="1" d="M20 6 9 17l-5-5"/>',
  redo: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  spark: `<path d="${SPARK}"/>`,
  sparkles: `<path class="s0" d="${SPARK}"/><path class="s1" d="M20 3v4"/><path class="s1" d="M22 5h-4"/><path class="s2" d="M4 17v2"/><path class="s2" d="M5 18H3"/>`,
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
};

export function iconSvg(name: IconName, cls = "icon"): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}

export function iconEl(name: IconName, cls = "icon"): SVGElement {
  const t = document.createElement("template");
  t.innerHTML = iconSvg(name, cls);
  return t.content.firstElementChild as SVGElement;
}
