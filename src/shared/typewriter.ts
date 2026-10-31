/**
 * Catch-up reveal: the server may deliver the whole answer in one burst, so show text smoothly.
 * render() gets the visible prefix; the caller does the DOM work (and scroll-sticking).
 */
export interface Typewriter {
  push(fullText: string): void;
  drain(): Promise<void>;
  cancel(): void;
}

export function createTypewriter(render: (visible: string) => void): Typewriter {
  let raf = 0, shown = 0, latest = "";
  let waiter: (() => void) | null = null;
  const tick = (): void => {
    raf = 0;
    if (shown < latest.length) {
      shown = Math.min(latest.length, shown + Math.max(2, Math.ceil((latest.length - shown) / 25)));
      render(latest.slice(0, shown));
    }
    if (shown < latest.length) raf = requestAnimationFrame(tick);
    else if (waiter) { const r = waiter; waiter = null; r(); }
  };
  const kick = (): void => { if (!raf) raf = requestAnimationFrame(tick); };
  return {
    push(t) { latest = t; kick(); },
    drain() {
      if (shown >= latest.length) return Promise.resolve();
      return new Promise<void>((r) => { waiter = r; kick(); });
    },
    cancel() { cancelAnimationFrame(raf); raf = 0; if (waiter) { const r = waiter; waiter = null; r(); } },
  };
}
