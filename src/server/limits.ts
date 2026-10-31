import { DAY_TTL } from "./config";

// Daily counters use the Pacific day = Google quota reset.
const LA = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const laParts = (now: Date) => Object.fromEntries(LA.formatToParts(now).map((p) => [p.type, p.value]));

/** "YYYY-MM-DD" in America/Los_Angeles. */
export function pacificDay(now = new Date()): string {
  const p = laParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Seconds until the next Pacific midnight (min 60). */
export function secondsToPacificMidnight(now = new Date()): number {
  const p = laParts(now);
  return Math.max(60, 86400 - (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)));
}

/** Adds model ids to today's "dead" list (skipped by auto for everyone until the Pacific day ends). */
export async function markDead(kv: KVNamespace, key: string, ids: string[]): Promise<void> {
  try {
    const cur = (await kv.get<string[]>(key, "json")) ?? [];
    await kv.put(key, JSON.stringify([...new Set([...cur, ...ids])]), { expirationTtl: DAY_TTL });
  } catch (e) {
    console.log("kv_dead_failed", String(e));
  }
}
