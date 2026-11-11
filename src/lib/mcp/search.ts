import { z } from "zod/v4";
import { env } from "@/lib/env";
import { Intent } from "@/lib/ai/intent";
import { SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { resolveIntent } from "@/lib/ai/resolve";
import { airlineName } from "@/lib/airlines";
import { clock, dayLabel, daysLater } from "@/lib/format";
import type { FilterSpec } from "@/lib/filterspec/schema";
import { specSummary } from "@/lib/filterspec/summary";
import { seatedCount, travelersText } from "@/lib/filterspec/travelers";
import { validateSpec } from "@/lib/filterspec/validate";
import { freshRunsLast24h, track, type Visit } from "@/lib/analytics";
import { runPlan } from "@/lib/planner";
import { compromises } from "@/lib/planner/compromise";
import type { PlanEvent, ScoredOffer } from "@/lib/planner/types";
import { verdict } from "@/lib/planner/verdict";
import { sellerHref } from "@/lib/clickout/links";
import { onFlight } from "@/lib/filterspec/flights";
import { replayable, resultsFresh, searchIdFor, searchStore } from "@/lib/searches";

/**
 * The search_flights tool. The traveller's own assistant (Claude, ChatGPT…) does the job our prompt parser does on
 * the site: it fills in the same Intent our Claude call writes, and from there it is the site's path exactly
 * (resolveIntent → validateSpec → runPlan). So an MCP search costs us the providers only, never a Claude call.
 * Anything too vague to search comes back as questions for the assistant to ask, before any money is spent.
 */

/** The Intent minus what only our own parser writes (its questions and readback). */
const SearchInput = Intent.omit({ questions: true, readback: true });

/** "Not stated" for every field: what the input is laid over, so the assistant only sends what the traveller said. */
const UNSTATED_DATE = { kind: "unstated", date: "", days: 0, month: "" } as const;
const NO_PREMIUM = { pct: 0, usd: 0 };
const NO_TIMES = { departNotBefore: "", departNotAfter: "", arriveNotBefore: "", arriveNotAfter: "", idealDepartFrom: "", idealDepartTo: "", idealArriveFrom: "", idealArriveTo: "", onlyOnDate: "" };
export const BLANK: Intent = {
  origin: { places: [], nearbyOk: "unstated", nearbyRadiusMiles: -1, nearbySavings: NO_PREMIUM },
  destination: { places: [], nearbyOk: "unstated" },
  oneWay: false,
  departEarliest: UNSTATED_DATE, departLatest: UNSTATED_DATE, returnEarliest: UNSTATED_DATE, returnLatest: UNSTATED_DATE,
  arriveBy: { date: UNSTATED_DATE, time: "" },
  tripLength: { minDays: -1, preferredDays: -1, maxDays: -1, flexibleIfCheaper: false },
  outboundDays: { days: [], mode: "unstated", premium: NO_PREMIUM },
  returnDays: { days: [], mode: "unstated", premium: NO_PREMIUM },
  outboundTimes: NO_TIMES, returnTimes: NO_TIMES, timesApplyToBothDirections: "unstated",
  travelers: { adults: 1, childrenAges: [], infants: 0, infantsInSeat: 0, nationalities: [] },
  bags: { carryOn: 1, checked: 0, pooled: false },
  cabin: { default: "economy", allowMixed: true, lieFlatOnLegsOverHours: -1, economyOkUnderHours: -1, upgradeReportCabin: "none", upgradeReportMaxDeltaUsd: 0 },
  route: {
    maxStops: -1, nonstop: { mode: "unstated", premium: NO_PREMIUM }, minLayoverMin: -1, maxLayoverMin: -1, allowOvernightLayover: "unstated",
    allowSelfTransfer: "unstated", selfTransferRequireSavingsPct: -1, avoidTransitCountries: [], avoidAirports: [], preferHubs: [],
    maxTotalTravelHours: -1, excludeTransitVisaRoutings: false,
  },
  airlines: { preferCarriers: [], preferAlliances: [], preferPremium: NO_PREMIUM, avoid: [], exclude: [], exceptions: [] },
  exactFlights: { outbound: [], return: [], premium: NO_PREMIUM },
  fare: { excludeBasicEconomy: false, refundable: "any", changeable: "any", changeFeeMaxUsd: -1, seatSelection: "any" },
  rankBy: "unstated",
  budget: { maxUsdPerPerson: -1, maxUsdTotal: -1 },
  stopover: { stated: false, direction: "outbound", places: [], days: 0, maxAddedUsd: 0 },
  amenities: { wifi: "unstated", lieFlat: "unstated", onSegmentHoursGte: -1 },
  blackouts: [],
  questions: [],
  readback: "",
};

/** Objects merge, everything else replaces; null means "not said", like leaving the field out. */
function overlay(base: unknown, over: unknown): unknown {
  if (over === null || over === undefined) return base;
  if (base && typeof base === "object" && !Array.isArray(base) && over && typeof over === "object" && !Array.isArray(over)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over)) out[k] = overlay(out[k], v);
    return out;
  }
  return over;
}

/** The input laid over BLANK and checked: the full Intent, or what is wrong with it in the assistant's terms. */
export function intentFrom(args: unknown): { intent: Intent } | { error: string } {
  const check = Intent.safeParse(overlay(BLANK, args));
  if (check.success) return { intent: { ...check.data, questions: [], readback: "" } };
  return { error: check.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

/**
 * The input schema as the assistant sees it: every field optional, unknown fields allowed, and without the sentinel
 * notes ("-1 if not stated") or the integer range Zod writes on every int, since leaving a field out says the same.
 */
function loosen(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(loosen);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "required" || k === "additionalProperties" || k === "$schema") continue;
    if ((k === "minimum" || k === "maximum") && Math.abs(v as number) === Number.MAX_SAFE_INTEGER) continue;
    if (k === "description") {
      const d = (v as string).replace(/;?\s*(-1|0|zeros) if (not stated|none)/g, "").replace(/,? else (0|empty string)$/, "").replace(/;?\s*empty if not stated$/, "").trim();
      if (d) out[k] = d;
      continue;
    }
    out[k] = loosen(v);
  }
  return out;
}
/**
 * What each top-level argument is for, where the Intent schema itself says nothing. Kept here rather than as
 * .describe() on the Intent, which is also the schema our own parser's Claude call is given: wording added there
 * would change what the site's parser reads. Assistants and MCP directories both read these.
 */
const ARG_NOTES: Record<string, string> = {
  origin: "Where the trip starts: the places the traveller named, and whether nearby airports are acceptable",
  destination: "Where the trip goes: one place, or several as alternatives (the cheapest wins)",
  oneWay: "true for a one-way trip; leave out for a round trip",
  departEarliest: "Earliest date the traveller can leave: an absolute date, days from today, or a whole month",
  departLatest: "Latest date the traveller can leave; the same as departEarliest for one fixed date",
  returnEarliest: "Earliest date the traveller can fly back",
  returnLatest: "Latest date the traveller can fly back",
  arriveBy: "A deadline at the destination: the date, and optionally the local time, they must have arrived by",
  tripLength: "How many days the stay lasts: a minimum, a preferred length, a maximum, and whether a different length is fine when cheaper",
  outboundDays: "Days of the week for the depart flight, as a requirement (hard) or a preference (soft, with how much more they would pay for it)",
  returnDays: "Days of the week for the return flight, hard or soft as for outboundDays",
  outboundTimes: "Clock-time limits for the depart flight: hard not-before / not-after bounds and softer ideal windows, for departure and arrival",
  returnTimes: "Clock-time limits for the return flight, as for outboundTimes",
  timesApplyToBothDirections: "yes when the traveller gave one set of times meant for both the depart and the return flight",
  travelers: "Who is flying: adults, each child's age, babies on a lap or in their own seat, and nationalities when given",
  bags: "Bags to include in the price: carry-ons and checked bags (per person, or shared across the group when pooled)",
  cabin: "Cabin class, whether mixing cabins between legs is fine, and any upgrade the traveller wants priced",
  route: "Stops and connections: nonstop as a requirement or a preference, layover lengths, overnight and self-transfer connections, airports or countries to avoid, total travel time",
  airlines: "Airlines and alliances to prefer, to rather not fly (soft), or never to fly (hard), with any exceptions",
  fare: "Fare rules: basic economy excluded or not, refundable, changeable, largest acceptable change fee, seat selection",
  budget: "The most the traveller will pay in USD, per person or for the whole group",
  stopover: "A deliberate multi-day stop on the way: where, on which direction, for how many days, and how much extra it may cost",
  amenities: "On-board needs: wifi, a lie-flat seat, and the flight length from which they matter",
};

function withArgNotes(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties as Record<string, Record<string, unknown>>;
  for (const [name, note] of Object.entries(ARG_NOTES)) if (props[name] && !props[name].description) props[name] = { description: note, ...props[name] };
  return schema;
}

export const inputSchema = withArgNotes(loosen(z.toJSONSchema(SearchInput)) as Record<string, unknown>);

/**
 * Our parser's rules, minus the ones about its own output (readback wording, its JSON, the form): the assistant follows
 * the same rules for places, dates, hard vs soft, stays and stops, so a search means the same thing from either door.
 */
const PARSER_ONLY = ["- \"Not stated\"", "- Form fields", "- Ask at most", "- Question field names", "- The readback", "- Writing style", "- Output only"];
export const FILLING_RULES = SYSTEM_PROMPT.split("\n").filter((l) => l.startsWith("- ") && !PARSER_ONLY.some((p) => l.startsWith(p))).join("\n");

export const TOOL_DESCRIPTION = `Search flights on Pinpoint Flights, a flight search with very deep filters: exact time windows, nonstop vs. price trade-offs, bags, fare rules, airlines to avoid, flexible dates and trip lengths, nearby airports, several destinations at once. Fill in only what the traveller said and leave everything else out (defaults apply). If something that changes the results is missing (dates, how long the stay is, an airport we can't place), no search runs: you get questions back to ask the traveller, then call again with the answers. Each traveller has ${env.mcpDailySearches} searches a day, so ask before searching when the request is vague, and don't run near-identical searches to compare: one search already prices many date combinations. Repeating a search from the last 24 hours is free. Results come with a link to the full results on pinpoint.flights, and each flight that can be booked has its own book_url: show the traveller the best match and every flight in each section (up to 10 in all), in rank order, each with its price, times, stops, airline and book_url, not just the top one or two; mention same-price swaps when a flight lists them; and give them the results link too, since booking happens there.

How to fill the fields (these are the rules the site's own assistant follows; where they say "readback", that means what you tell the traveller):
${FILLING_RULES}`;

export const SERVER_INSTRUCTIONS = `Pinpoint Flights finds the flight that fits exactly what the traveller asked for. Use search_flights for any flight search. Ask the traveller the questions it returns rather than guessing, show the traveller every flight a search returns (the best match, then each section, each flight with its book_url), give them the results link (booking happens there), and pass on any message in "tell_the_traveller".`;

// ── Running a search ──

export type Caller = { keyId: string; visit: Visit; siteOrigin: string };
type Usage = { used: number; limit: number; left: number; resetsAt?: string };

/** One search per key at a time, so a double call can't run two paid searches past the allowance. In-memory data. */
const g = globalThis as unknown as { __pinpointMcpBusy?: Set<string> };
const busy: Set<string> = (g.__pinpointMcpBusy ??= new Set());

async function usageOf(keyId: string): Promise<Usage> {
  const runs = await freshRunsLast24h(`mcp:${keyId}`);
  const limit = env.mcpDailySearches;
  const resetsAt = runs.length >= limit ? new Date(Date.parse(runs[runs.length - limit]) + 86_400_000).toISOString() : undefined;
  return { used: runs.length, limit, left: Math.max(0, limit - runs.length), resetsAt };
}

/** "You have 2 searches left today", from the warn-after point on; null before it. */
export function allowanceNote(u: Usage): string | null {
  if (u.left === 0) return `That was the last of today's ${u.limit} searches with Pinpoint Flights. Reopening any of today's searches is still free, and so is the website.`;
  if (u.used < env.mcpWarnAfter) return null;
  return `Heads up: you have ${u.left} search${u.left === 1 ? "" : "es"} left today with Pinpoint Flights (${u.limit} a day).`;
}

/** What blocks a search before any money is spent: the questions the traveller has to answer. */
function questionsFor(it: Intent, spec: FilterSpec, today: string): Array<{ field: string; question: string }> {
  const q: Array<{ field: string; question: string }> = [];
  const unplaced = (side: "origin" | "destination") => {
    const p = spec[side];
    if (p.airports.length || p.region) return;
    const said = it[side].places.join(", ");
    q.push({ field: side, question: said ? `I couldn't find an airport for "${said}". Which city or airport did you mean?` : side === "origin" ? "Where are you flying from?" : "Where do you want to go?" });
  };
  unplaced("origin");
  unplaced("destination");
  // The site's resolver falls back to "in a week or so" for missing dates (the form always has some); here, ask.
  if (it.departEarliest.kind === "unstated" && it.departLatest.kind === "unstated" && it.arriveBy.date.kind === "unstated")
    q.push({ field: "dates", question: "When would you like to leave? A date, a range or a month is fine." });
  for (const w of validateSpec(spec, today)) if (w.severity === "ask" && !q.some((x) => x.field === w.field.split(".")[0])) q.push({ field: w.field, question: w.message });
  return q;
}

export async function searchFlights(args: unknown, caller: Caller): Promise<{ result: Record<string, unknown>; isError?: boolean }> {
  const today = new Date().toISOString().slice(0, 10);
  const parsed = intentFrom(args);
  if ("error" in parsed) return { isError: true, result: { error: `Some fields are not in the expected shape: ${parsed.error}. Fix those and call again.` } };
  let spec: FilterSpec;
  try { spec = resolveIntent(parsed.intent, today).spec; } catch (e) { return { isError: true, result: { error: (e as Error).message } }; }

  const understood = { summary: specSummary(spec, today), travelers: travelersText(spec.travelers), today };
  const questions = questionsFor(parsed.intent, spec, today);
  // Without dates the summary would show the resolver's stand-in window, as if the traveller had said it.
  if (questions.length) return { result: { status: "needs_answers", questions, understood: questions.some((q) => q.field === "dates") ? { travelers: understood.travelers, today } : understood, note: "No search was run and none was counted. Ask the traveller these, then call again with the answers." } };

  const store = searchStore();
  // Saving again would replace the page state of the same search made on the site (its prompt), so only save new ones.
  const stored = await store.get(searchIdFor(spec));
  const id = stored?.id ?? await store.save(spec, {});
  const link = `${caller.siteOrigin}/s/${id}`;
  await track(caller.visit, "search_saved", { searchId: id, data: { source: "mcp", summary: understood.summary } });

  // The same search inside the cache window replays for free, as reopening a link on the site does.
  if (stored && resultsFresh(stored)) {
    await track(caller.visit, "search_run", { searchId: id, data: { fresh: false } });
    return { result: { status: "results", ...describeResults(stored.results!, spec, caller.siteOrigin, id), understood, link, cached_at: stored.resultsAt, usage: await usageOf(caller.keyId) } };
  }

  const before = await usageOf(caller.keyId);
  if (before.left === 0) {
    return { result: { status: "limit_reached", understood, link, usage: before, tell_the_traveller: `You've used today's ${before.limit} searches with Pinpoint Flights. The next one frees up at ${before.resetsAt} (UTC). You can also search on the website: ${link}` } };
  }
  if (busy.has(caller.keyId)) return { isError: true, result: { error: "Another search for this traveller is still running. Wait for it to finish." } };
  const spent = await store.spendLast24h().catch(() => 0);
  if (spent >= env.maxDailySpendUsd) return { result: { status: "unavailable", understood, link, tell_the_traveller: "Pinpoint Flights has hit its daily search budget. Please try again later." } };

  busy.add(caller.keyId);
  const keep: PlanEvent[] = [];
  try {
    for await (const ev of runPlan(spec, today, crypto.randomUUID())) if (replayable(ev)) keep.push(ev);
  } catch (e) {
    keep.push({ type: "status", stage: "error", message: (e as Error).message });
  } finally {
    busy.delete(caller.keyId);
    const done = keep.find((e): e is Extract<PlanEvent, { type: "done" }> => e.type === "done");
    if (done) await store.saveResults(id, keep).catch(() => {});
    // Counted even when it failed partway: the providers it did reach were paid for.
    await track(caller.visit, "search_run", { searchId: id, costUsd: done?.costUsd ?? 0, data: { fresh: true, via: "mcp", verdict: verdict(finalOffers(keep)).kind, calls: done?.calls, ms: done?.ms, offers: done?.offers } });
  }
  const error = keep.find((e) => e.type === "status" && e.stage === "error");
  const usage = await usageOf(caller.keyId);
  const note = allowanceNote(usage);
  if (error && !keep.some((e) => e.type === "done")) return { isError: true, result: { error: `The search failed: ${(error as { message: string }).message}`, usage } };
  return { result: { status: "results", ...describeResults(keep, spec, caller.siteOrigin, id), understood, link, usage, ...(note ? { tell_the_traveller: note } : {}) } };
}

function finalOffers(events: PlanEvent[]): ScoredOffer[] {
  return events.find((e): e is Extract<PlanEvent, { type: "offers" }> => e.type === "offers" && e.final)?.offers ?? [];
}

// ── What the assistant gets back ──

/** Flights in the answer, counting the best match. Same-price swaps ride along with their flight and don't count. */
const SHOWN = 10;

type Entry = { o: ScoredOffer; rank: number; otherReturns: ScoredOffer[]; otherDepartures: ScoredOffer[] };

/**
 * The top of the results in a shape an assistant can read out: the verdict, the best match on its own, then up to
 * nine more in sections that fit this search (on the named flight or not, by dates, nonstop or not, by airports), and
 * when nothing fits, what to give up. A round trip that differs from a better one only in one flight, at the same
 * price, is folded into it as a swap ("same price with any of these returns") instead of taking a place of its own.
 */
export function describeResults(events: PlanEvent[], spec: FilterSpec, origin: string, id: string): Record<string, unknown> {
  const offers = finalOffers(events);
  const runId = events.find((e): e is Extract<PlanEvent, { type: "done" }> => e.type === "done")?.searchId;
  const bookUrl = (o: ScoredOffer) => { const href = o.sellers.map((s) => sellerHref(s, o.id, runId, id)).find(Boolean); return href ? `${origin}${href}` : undefined; };
  const v = verdict(offers);
  const passing = offers.filter((o) => !o.hardFails.length);
  const warnings = events.filter((e): e is Extract<PlanEvent, { type: "warning" }> => e.type === "warning").map((e) => e.message);
  const summary =
    v.kind === "perfect" ? "The best match meets everything the traveller asked for."
    : v.kind === "good" ? `The best match meets every requirement but gives up: ${v.gives.concat(v.unconfirmed.map((u) => `${u} (not verified)`)).join(", ")}.${v.exact ? ` The best flight that gives up nothing is #${v.exact.rank}.` : ""}`
    : v.kind === "none" ? "No flight meets every requirement. The closest ones are below with what each misses; the compromise questions say what to relax."
    : "No flights came back for these dates and places.";

  const entries = withSwaps(passing.length ? passing : offers).slice(0, SHOWN);
  const show = (e: Entry) => ({
    ...flight(e.o, e.rank, spec, bookUrl(e.o)),
    ...(e.otherReturns.length ? { same_price_other_returns: e.otherReturns.map((x) => ({ ...leg(x.slices[1], 1, 2), ...(bookUrl(x) ? { book_url: bookUrl(x) } : {}) })) } : {}),
    ...(e.otherDepartures.length ? { same_price_other_departures: e.otherDepartures.map((x) => ({ ...leg(x.slices[0], 0, 2), ...(bookUrl(x) ? { book_url: bookUrl(x) } : {}) })) } : {}),
  });
  const [best, ...rest] = entries;
  const swaps = entries.some((e) => e.otherReturns.length || e.otherDepartures.length);
  return {
    verdict: v.kind,
    summary,
    matches: passing.length,
    // Assistants tend to show only the top one or two; the owner wants the traveller to see the whole list.
    how_to_show: `Show the best match first, then each section under its title with every flight in it, in rank order: price, times, stops, airline and book_url link.${swaps ? " Where a flight lists same_price_other_returns or same_price_other_departures, tell the traveller they can swap to any of those flights for the same price." : ""}${spec.exactFlights ? " For the flights the traveller named, take the times from named_flights and say whether each was found." : ""} End with the link to the full results.`,
    ...(spec.exactFlights ? { named_flights: namedFlights(offers, spec.exactFlights) } : {}),
    ...(best ? { best_match: show(best) } : {}),
    sections: sections(rest, spec).map((g) => ({ title: g.title, flights: g.entries.map(show) })),
    ...(v.kind === "none" ? { compromises: compromises(spec, offers).map((c) => ({ question: c.question, example: c.example, flights_affected: c.count })) } : {}),
    ...(warnings.length ? { notes: warnings } : {}),
  };
}

/**
 * Each flight the traveller named, as found in the fares: its real date and times (which also settle "7:59, AM or
 * PM?") and the cheapest fare on it, or that this search didn't find it, so the assistant never guesses its time.
 */
function namedFlights(offers: ScoredOffer[], exact: NonNullable<FilterSpec["exactFlights"]>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [i, list] of [[0, exact.outbound], [1, exact.return]] as const) for (const name of list) {
    const on = offers.filter((o) => o.slices[i] && onFlight(o.slices[i].segments.map((g) => g.flightNumber), [name]));
    const g = on[0]?.slices[i].segments.find((x) => onFlight([x.flightNumber], [name]));
    out.push(g
      ? { flight: name, direction: i === 0 ? "depart" : "return", found: true, date: dayLabel(g.departAt), departs: clock(g.departAt), arrives: clock(g.arriveAt), from: g.origin, to: g.destination, cheapest_fare_usd: Math.min(...on.map((o) => Math.round(o.allInPrice))) }
      : { flight: name, direction: i === 0 ? "depart" : "return", found: false, note: "Not among the fares this search found; its time is unknown here, so don't state one." });
  }
  return out;
}

/** Ranked fares as entries, each later round trip that only swaps one flight at the same price folded into the first. */
export function withSwaps(ranked: ScoredOffer[]): Entry[] {
  const legKey = (o: ScoredOffer, i: number) => o.slices[i].segments.map((g) => `${g.flightNumber}@${g.departAt.slice(0, 16)}`).join(">");
  const entries: Entry[] = [];
  ranked.forEach((o, i) => {
    const twoWay = o.slices.length === 2;
    const same = twoWay && entries.find((e) => e.o.slices.length === 2 && Math.round(e.o.allInPrice) === Math.round(o.allInPrice)
      && (legKey(e.o, 0) === legKey(o, 0) || legKey(e.o, 1) === legKey(o, 1)));
    if (!same) { entries.push({ o, rank: i + 1, otherReturns: [], otherDepartures: [] }); return; }
    if (legKey(same.o, 0) === legKey(o, 0)) same.otherReturns.push(o);
    else same.otherDepartures.push(o);
  });
  return entries;
}

/**
 * The sections after the best match, by the first thing that tells these flights apart and matters to this search:
 * the flight the traveller named, the dates, nonstop or not, the airports. One "More options" section otherwise.
 */
function sections(entries: Entry[], spec: FilterSpec): Array<{ title: string; entries: Entry[] }> {
  const exact = spec.exactFlights;
  const named = (o: ScoredOffer) => o.slices.every((s, i) => {
    const wanted = i === 0 ? exact?.outbound ?? [] : i === 1 ? exact?.return ?? [] : [];
    return !wanted.length || onFlight(s.segments.map((g) => g.flightNumber), wanted);
  });
  const dims: Array<(o: ScoredOffer) => string> = [
    ...(exact ? [(o: ScoredOffer) => (named(o) ? "On the flight you named" : "Other flights")] : []),
    (o) => o.slices.map((s, i) => `${o.slices.length === 1 ? "Leaving" : i === 0 ? "Leaving" : "back"} ${dayLabel(s.segments[0].departAt)}`).join(", "),
    (o) => (o.slices.every((s) => s.segments.length === 1) ? "Nonstop" : "With a stop"),
    (o) => o.slices.map((s) => `${s.segments[0].origin} → ${s.segments[s.segments.length - 1].destination}`).join(", "),
  ];
  for (const dim of dims) {
    const titles = [...new Set(entries.map((e) => dim(e.o)))];
    if (titles.length < 2 || titles.length > 5) continue;
    return titles.map((title) => ({ title, entries: entries.filter((e) => dim(e.o) === title) }));
  }
  return entries.length ? [{ title: "More options", entries }] : [];
}

function hm(min: number): string {
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

function leg(s: ScoredOffer["slices"][number], i: number, of: number): Record<string, unknown> {
  const first = s.segments[0], last = s.segments[s.segments.length - 1];
  const plus = daysLater(first.departAt, last.arriveAt);
  return {
    leg: of === 1 ? "one way" : i === 0 ? "outbound" : "return",
    date: dayLabel(first.departAt),
    from: first.origin, to: last.destination,
    departs: clock(first.departAt),
    arrives: clock(last.arriveAt) + (plus > 0 ? ` (+${plus})` : ""),
    duration: hm(s.durationMin),
    stops: s.segments.length - 1,
    ...(s.segments.length > 1 ? { via: s.segments.slice(1).map((g) => g.origin) } : {}),
    airlines: [...new Set(s.segments.map((g) => airlineName(g.marketingCarrier)))],
    flights: s.segments.map((g) => g.flightNumber),
  };
}

/** `bookUrl` is where the fare's button on the site goes (the same link, so it is logged the same way). */
function flight(o: ScoredOffer, rank: number, spec: FilterSpec, bookUrl?: string): Record<string, unknown> {
  const seats = seatedCount(spec.travelers);
  return {
    rank,
    price_usd: Math.round(o.allInPrice),
    ...(seats > 1 ? { per_person_usd: Math.round(o.allInPrice / seats) } : {}),
    legs: o.slices.map((s, i) => leg(s, i, o.slices.length)),
    cabin: o.fareBrand ? `${o.cabin} (${o.fareBrand})` : o.cabin,
    ...(o.basicEconomy ? { basic_economy: true } : {}),
    ...(o.bagAllowance ? { bags_included_per_person: o.bagAllowance } : {}),
    ...(o.conditions ? { fare_rules: o.conditions } : {}),
    ...(o.hardFails.length ? { misses: (o.misses ?? []).map((m) => (m.have ? `${m.label} (this flight: ${m.have})` : m.label)) } : {}),
    ...(o.lines.some((l) => l.pref) ? { gives_up: o.lines.filter((l) => l.pref).map((l) => l.label) } : {}),
    ...(o.unverified?.length ? { not_verified: o.unverified } : {}),
    price_from: o.source,
    ...(bookUrl ? { book_url: bookUrl } : {}),
    ...(o.cheaperElsewhere ? { also_listed_on_google_flights_usd: Math.round(o.cheaperElsewhere.price) } : {}),
  };
}
