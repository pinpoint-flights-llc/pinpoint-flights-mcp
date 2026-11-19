import { describe, expect, it } from "vitest";
import { env } from "../src/lib/env";
import { mintKey, verifyKey } from "../src/lib/mcp/keys";
import { FILLING_RULES, allowanceNote, inputSchema, intentFrom, searchFlights, withSwaps } from "../src/lib/mcp/search";
import type { ScoredOffer } from "../src/lib/planner/types";
import { handle } from "../src/lib/mcp/server";

const caller = (keyId: string) => ({ keyId, siteOrigin: "https://pinpoint.flights", visit: { visitor: `mcp:${keyId}` } });

describe("connector keys", () => {
  it("verify only when untouched", () => {
    const key = mintKey();
    expect(key).toHaveLength(28);
    expect(verifyKey(key)).toBe(key.slice(0, 12));
    const flipped = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(verifyKey(flipped)).toBeNull();
    expect(verifyKey("short")).toBeNull();
  });
});

describe("what the assistant sends", () => {
  it("only needs what the traveller said; the rest is 'not stated'", () => {
    const r = intentFrom({ origin: { places: ["Orlando"] }, destination: { places: ["DCA"] }, departEarliest: { kind: "absolute", date: "2027-03-05" }, cabin: null });
    expect("intent" in r).toBe(true);
    if (!("intent" in r)) return;
    expect(r.intent.origin.places).toEqual(["Orlando"]);
    expect(r.intent.departEarliest).toEqual({ kind: "absolute", date: "2027-03-05", days: 0, month: "" });
    expect(r.intent.departLatest.kind).toBe("unstated");
    expect(r.intent.cabin.default).toBe("economy");
  });
  it("says which field is wrong", () => {
    const r = intentFrom({ cabin: { default: "lie-flat" } });
    expect("error" in r && r.error).toContain("cabin.default");
  });
  it("shows a schema with nothing required", () => {
    const keys = (n: unknown): string[] => (n && typeof n === "object" ? Object.entries(n).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    expect(keys(inputSchema)).not.toContain("required");
    expect(JSON.stringify(inputSchema)).not.toContain("not stated");
    // Every argument says what it is for: assistants read it, and MCP directories score a tool on it.
    const props = (inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(Object.keys(props).filter((k) => !props[k].description)).toEqual([]);
    expect(Object.keys((inputSchema as { properties: object }).properties)).not.toContain("readback");
  });
  it("carries the parser's filling rules, not its output rules", () => {
    expect(FILLING_RULES).toContain("- Places:");
    expect(FILLING_RULES).toContain("- Trip length:");
    expect(FILLING_RULES).toContain("- Clock times without AM or PM:");
    expect(FILLING_RULES).not.toContain("- The readback");
    expect(FILLING_RULES).not.toContain("- Form fields");
  });
});

describe("protocol", () => {
  it("initializes, lists the tool, and ignores notifications", async () => {
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, caller("k1"));
    expect(init?.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, caller("k1"));
    expect((list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(["search_flights"]);
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, caller("k1"))).toBeNull();
    expect((await handle({ jsonrpc: "2.0", id: 3, method: "nope" }, caller("k1")))?.error?.code).toBe(-32601);
  });
  it("lets a caller with no key look but not search", async () => {
    const list = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, caller(""));
    expect((list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(["search_flights"]);
    const call = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_flights", arguments: { origin: { places: ["Orlando"] } } } }, caller(""));
    const res = call?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("https://pinpoint.flights/connect");
  });
});

describe("search_flights", () => {
  it("asks instead of searching when the request is too vague, and doesn't count it", async () => {
    const { result } = await searchFlights({ origin: { places: ["Atlantis"] }, destination: { places: ["Lisbon"] } }, caller("vague"));
    expect(result.status).toBe("needs_answers");
    const fields = (result.questions as Array<{ field: string }>).map((q) => q.field);
    expect(fields).toContain("origin");
    expect(fields).toContain("dates");
  });

  it("searches (demo data here), links to the results, and warns from the 5th search on", async () => {
    const id = "allowance-test";
    const notes: Array<unknown> = [];
    for (let i = 0; i < env.mcpDailySearches + 1; i++) {
      const { result } = await searchFlights({
        origin: { places: ["MCO"] }, destination: { places: ["DCA"] }, oneWay: true,
        departEarliest: { kind: "relative_days", days: 30 + i }, departLatest: { kind: "relative_days", days: 30 + i },
      }, caller(id));
      notes.push(result.status === "results" ? result.tell_the_traveller ?? null : result.status);
      if (i === 0) {
        expect(result.results_url).toMatch(/^https:\/\/pinpoint\.flights\/s\/[A-Za-z0-9_-]{12}$/);
        const sections = result.sections as Array<{ title: string; flights: Array<{ book_url?: string }> }>;
        const flights = [result.best_match as { book_url?: string }, ...sections.flatMap((g) => g.flights)];
        expect(flights.length).toBeGreaterThan(1);
        expect(flights.length).toBeLessThanOrEqual(10);
        for (const f of flights) if (f.book_url) expect(f.book_url).toMatch(/^https:\/\/pinpoint\.flights\/(seller|book|out)/);
      }
    }
    expect(notes.slice(0, env.mcpWarnAfter - 1)).toEqual(Array(env.mcpWarnAfter - 1).fill(null));
    expect(notes[env.mcpWarnAfter - 1]).toContain("2 searches left");
    expect(notes[env.mcpDailySearches - 1]).toContain("last of today's");
    expect(notes[env.mcpDailySearches]).toBe("limit_reached");

    // The same search again inside the cache window is free, even past the limit.
    const again = await searchFlights({
      origin: { places: ["MCO"] }, destination: { places: ["DCA"] }, oneWay: true,
      departEarliest: { kind: "relative_days", days: 30 }, departLatest: { kind: "relative_days", days: 30 },
    }, caller(id));
    expect(again.result.status).toBe("results");
    expect(again.result.cached_at).toBeTruthy();
  }, 60_000);

  it("words the allowance", () => {
    expect(allowanceNote({ used: 4, limit: 7, left: 3 })).toBeNull();
    expect(allowanceNote({ used: 6, limit: 7, left: 1 })).toContain("1 search left");
  });
});

describe("same-price swaps", () => {
  const seg = (fn: string, at: string) => ({ origin: "X", destination: "Y", departAt: at, arriveAt: at, marketingCarrier: fn.slice(0, 2), flightNumber: fn, durationMin: 60 });
  const trip = (out: string, back: string, price: number) =>
    ({ id: `${out}-${back}`, allInPrice: price, slices: [{ segments: [seg(out, "2026-10-26T21:42:00")] }, { segments: [seg(back, "2026-10-28T13:59:00")] }] }) as unknown as ScoredOffer;
  it("folds a later round trip that only changes one flight at the same price into the first", () => {
    const e = withSwaps([trip("AA2668", "AA2509", 499), trip("AA2668", "AA1643", 499), trip("B62324", "B62423", 497), trip("AA2668", "AA2139", 591)]);
    expect(e.map((x) => [x.o.id, x.rank])).toEqual([["AA2668-AA2509", 1], ["B62324-B62423", 3], ["AA2668-AA2139", 4]]);
    expect(e[0].otherReturns.map((x) => x.id)).toEqual(["AA2668-AA1643"]);
  });
});

describe("GET on the server's address", () => {
  it("tells an agent that opened the link how to call it, and gives MCP stream requests the 405", async () => {
    const { NextRequest } = await import("next/server");
    const { guide } = await import("../src/lib/mcp/serve");
    const opened = guide(new NextRequest("https://pinpoint.flights/mcp/abc123"), true);
    expect(opened.status).toBe(200);
    const text = await opened.text();
    expect(text).toContain("curl -s https://pinpoint.flights/mcp/abc123");
    expect(text).toContain('"method":"tools/list"');
    expect(text).toContain("results_url");
    expect(text).not.toContain("Authorization: Bearer <key>\" -d");
    expect(await guide(new NextRequest("https://pinpoint.flights/mcp"), false).text()).toContain('-H "Authorization: Bearer <key>"');
    expect(guide(new NextRequest("https://pinpoint.flights/mcp/abc123", { headers: { accept: "text/event-stream" } }), true).status).toBe(405);
  });
});
