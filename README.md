# Pinpoint Flights MCP server

Source of the hosted MCP server for [Pinpoint Flights](https://pinpoint.flights),
a flight search with very deep filters: exact time windows, nonstop vs. price
trade-offs, bags, fare rules, airlines to avoid, flexible dates and trip
lengths, nearby airports, and several destinations at once.

Ask your assistant for flights in your own words. It fills in the filters,
asks you what it needs to know, and brings back the best matches with links to
book on pinpoint.flights.

Fla. Seller of Travel Reg. No. ST150266

## Use it

You don't need to run anything from this repository. The server is hosted, and
listed in the official MCP Registry as `flights.pinpoint/pinpoint-flights`.

1. Get your free personal link at <https://pinpoint.flights/connect>. It looks
   like `https://pinpoint.flights/mcp/<key>`.
2. Add it to your assistant in one of two ways:
   - **As a URL:** paste the personal link as a custom connector (Gemini,
     Claude, ChatGPT).
   - **As a header:** connect to `https://pinpoint.flights/mcp` and send the
     key, the last part of your link, as `Authorization: Bearer <key>`. For
     example, in Claude Code:

     ```bash
     claude mcp add --transport http pinpoint-flights https://pinpoint.flights/mcp \
       --header "Authorization: Bearer <key>"
     ```

   - **Straight from an agent:** an agent that can make web requests (Claude
     Code, Codex, Cursor) can be handed the personal link in a message. Opening
     it with a plain GET returns how to call it with ordinary JSON-RPC POSTs.
     The "Use your agent" button on the pinpoint.flights home page gives a
     ready prompt with the link in it.

Results lead with `results_url`, the full results page on pinpoint.flights,
and each flight that can be booked has a `book_url`.

Without a key the server still connects and lists its tool, but a search
answers with where to get one. Each key has a daily allowance of fresh
searches; repeating a search from the last 24 hours is free. Keys are handed
out, and tickets sold, only where Pinpoint Flights is able to sell travel.

## The tool

There is one, `search_flights`, annotated read-only. Its arguments are the
filters themselves, all optional: the assistant sends only what you said and
defaults cover the rest.

| Argument group | What it carries |
|---|---|
| `origin`, `destination` | Places, nearby airports, several destinations as alternatives |
| `departEarliest` … `returnLatest`, `arriveBy`, `tripLength`, `blackouts` | Fixed or flexible dates, a deadline, how long the stay is |
| `outboundDays`, `returnDays`, `outboundTimes`, `returnTimes` | Days of the week and clock-time windows, as requirements or preferences |
| `travelers`, `bags`, `cabin`, `fare`, `budget` | Who is flying, bags to price in, cabin, fare rules, a price ceiling |
| `route`, `airlines`, `exactFlights`, `stopover`, `amenities` | Stops and layovers, airlines to prefer or avoid, a specific flight to be on |

If something that changes the results is missing, such as the dates, no search
runs: the tool returns questions for the assistant to ask you first.

## What is in this repository

| File | |
|---|---|
| `src/lib/mcp/server.ts` | The MCP protocol: initialize, tools/list, tools/call |
| `src/lib/mcp/search.ts` | The `search_flights` tool: its schema, description, and how results are presented |
| `src/lib/mcp/serve.ts`, `src/app/mcp/` | The two HTTP addresses, with and without the key in the URL |
| `src/lib/mcp/keys.ts` | How connector keys are made and checked |
| `src/lib/mcp/server.json` | The MCP Registry manifest |
| `tests/mcp.test.ts` | Tests |

This is a copy of the server's files from the Pinpoint Flights codebase, kept
here so the code behind the hosted server can be read. It is not a standalone
project and does not build on its own: the search itself (the planner, the
fare providers, the rest of the site) is not part of this repository.

## Questions and problems

Open an issue here, or write to support@pinpoint.flights.
