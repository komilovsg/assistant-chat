import { describe, expect, it } from "vitest";
import { MAX_LAST, MAX_MSGS } from "../src/server/config";
import { classifyUpstream } from "../src/server/gemini";
import { originAllowed } from "../src/server/http";
import { pacificDay, secondsToPacificMidnight } from "../src/server/limits";
import { toInput, validate } from "../src/server/validate";

const u = (text: string) => ({ role: "user", text });

describe("validate", () => {
  it("accepts a minimal valid body", () => {
    expect(validate({ model: "auto", messages: [u("hi")] })).toBeNull();
  });
  it("rejects non-objects and missing fields", () => {
    expect(validate(null)).not.toBeNull();
    expect(validate("x")).not.toBeNull();
    expect(validate({ messages: [u("hi")] })).not.toBeNull();
  });
  it("rejects a bad role", () => {
    expect(validate({ model: "auto", messages: [{ role: "system", text: "x" }, u("hi")] })).toMatch(/role/);
  });
  it("rejects a last message that is too long", () => {
    expect(validate({ model: "auto", messages: [u("a".repeat(MAX_LAST + 1))] })).toMatch(String(MAX_LAST));
    expect(validate({ model: "auto", messages: [u("a".repeat(MAX_LAST))] })).toBeNull();
  });
  it("rejects too many / zero messages", () => {
    expect(validate({ model: "auto", messages: Array.from({ length: MAX_MSGS + 1 }, () => u("x")) })).not.toBeNull();
    expect(validate({ model: "auto", messages: [] })).not.toBeNull();
  });
  it("requires the last message to be a non-empty user message", () => {
    expect(validate({ model: "auto", messages: [u("hi"), { role: "model", text: "yo" }] })).not.toBeNull();
    expect(validate({ model: "auto", messages: [u("   ")] })).not.toBeNull();
  });
});

describe("toInput", () => {
  it("drops leading model turns and maps roles", () => {
    const out = toInput([{ role: "model", text: "a" }, { role: "user", text: "b" }]);
    expect(out).toEqual([{ type: "user_input", content: [{ type: "text", text: "b" }] }]);
  });
});

describe("originAllowed", () => {
  const self = "https://chat.example.com";
  it("allows no Origin and same origin", () => {
    expect(originAllowed(null, self, "")).toBe(true);
    expect(originAllowed(self, self, "")).toBe(true);
  });
  it("blocks foreign origins by default", () => {
    expect(originAllowed("https://evil.test", self, "")).toBe(false);
  });
  it("allows exact matches from the list only", () => {
    const list = "https://a.test, https://b.test";
    expect(originAllowed("https://b.test", self, list)).toBe(true);
    expect(originAllowed("https://b.test:8443", self, list)).toBe(false);
    expect(originAllowed("http://a.test", self, list)).toBe(false);
    expect(originAllowed("https://a.test.evil.com", self, list)).toBe(false);
  });
  it("allows anything with *", () => {
    expect(originAllowed("https://whatever.test", self, "*")).toBe(true);
  });
  it("allows localhost ↔ localhost for dev", () => {
    expect(originAllowed("http://localhost:5173", "http://127.0.0.1:8787", "")).toBe(true);
    expect(originAllowed("http://localhost:5173", self, "")).toBe(false);
  });
});

describe("Pacific day", () => {
  it("uses America/Los_Angeles date", () => {
    // 2026-10-31 06:00 UTC = 2026-10-30 23:00 PDT
    expect(pacificDay(new Date("2026-10-31T06:00:00Z"))).toBe("2026-10-30");
    expect(pacificDay(new Date("2026-10-31T08:00:00Z"))).toBe("2026-10-31");
  });
  it("counts seconds to Pacific midnight (min 60)", () => {
    expect(secondsToPacificMidnight(new Date("2026-10-31T06:00:00Z"))).toBe(3600);
    expect(secondsToPacificMidnight(new Date("2026-10-31T06:59:30Z"))).toBe(60);
    // winter (PST, UTC-8): 2026-12-01 08:00 UTC = 00:00 PST
    expect(secondsToPacificMidnight(new Date("2026-12-01T08:00:00Z"))).toBe(86400);
  });
});

describe("classifyUpstream", () => {
  it("404 / 403 → dead", () => {
    expect(classifyUpstream(404, "")).toBe("dead");
    expect(classifyUpstream(403, "")).toBe("dead");
  });
  it("429 per-day → dead, per-minute → skip", () => {
    expect(classifyUpstream(429, "Quota exceeded for GenerateRequestsPerDayPerProjectPerModel")).toBe("dead");
    expect(classifyUpstream(429, "Quota exceeded: requests per minute")).toBe("skip");
  });
  it("503 / 500 → skip", () => {
    expect(classifyUpstream(503, "overloaded")).toBe("skip");
    expect(classifyUpstream(500, "")).toBe("skip");
  });
  it("401 → config", () => {
    expect(classifyUpstream(401, "")).toBe("config");
  });
});
