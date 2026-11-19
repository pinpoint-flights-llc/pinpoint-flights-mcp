import { NextRequest } from "next/server";
import { visitOf } from "@/lib/analytics";
import { allow } from "@/lib/ratelimit";
import { handle, type RpcReply } from "./server";

/**
 * One POST to the MCP server, for both doors: /mcp/<key> (the personal link from /connect, for assistants that only
 * take a URL) and /mcp (the address in the MCP Registry, with the key as `Authorization: Bearer <key>`).
 *
 * `keyId` is null when the caller sent no key, which only /mcp allows. Such a caller can connect and read the tool
 * list (how directories and clients look a server over before anyone signs up) but cannot search: tools/call answers
 * with where to get a key. Nothing paid runs without one, so the allowance and the spend caps are untouched.
 */
export async function serve(req: NextRequest, keyId: string | null): Promise<Response> {
  const rpcError = (status: number, code: number, message: string) => Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });
  const visit = visitOf(req.headers);
  if (!allow(keyId ? `mcp:${keyId}` : `mcp-open:${visit.ip ?? "local"}`, 30, 15)) return rpcError(429, -32002, "Too many requests. Try again in a minute.");

  let body: unknown;
  try { body = await req.json(); } catch { return rpcError(400, -32700, "Parse error"); }
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("host") ?? req.nextUrl.host;
  // Who asked, as far as the analytics page goes: the key, from wherever the assistant's servers are.
  const caller = { keyId: keyId ?? "", siteOrigin: `${proto}://${host}`, visit: { ...visit, visitor: keyId ? `mcp:${keyId}` : undefined } };

  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((m) => handle(m, caller)))).filter((r): r is RpcReply => r !== null);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

/** No server-to-client stream: everything comes back on the POST. */
export function postOnly(): Response {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

/**
 * GET on the server's address. An MCP client asking for a stream (Accept: text/event-stream) gets the 405 the spec
 * expects. Anything else is most likely an agent that was handed the link in a chat ("Use the Pinpoint Flights MCP
 * server at <link>…", from the home page's "Use your agent") and opened it to see what it is: it gets, in plain text,
 * how to call the server with ordinary POSTs, so it can search without being set up as a connector first.
 */
export function guide(req: NextRequest, keyed: boolean): Response {
  if ((req.headers.get("accept") ?? "").includes("text/event-stream")) return postOnly();
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("host") ?? req.nextUrl.host;
  const url = `${proto}://${host}${req.nextUrl.pathname}`;
  const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const auth = keyed ? "" : ' -H "Authorization: Bearer <key>"';
  const text = `Pinpoint Flights MCP server
${url}

This is a Model Context Protocol server (Streamable HTTP, stateless, JSON replies) with one tool, search_flights: a flight search with very deep filters (exact time windows, nonstop vs. price, bags, fare rules, airlines to avoid, flexible dates, several destinations).
${keyed ? "This link carries the traveller's own key: their daily searches are counted against it, so don't share it." : "Searching needs the traveller's own free key from https://pinpoint.flights/connect, sent as \"Authorization: Bearer <key>\" (or use the personal link it gives instead of this address)."}

Use it either way:
1. Add this URL to your MCP client as an HTTP (Streamable HTTP) server, then call search_flights.
2. Or call it directly with JSON-RPC 2.0 over HTTP POST. No session or initialize step is needed.

List the tool and its input schema (read the tool description: it says how to fill the fields and how to present the results):
curl -s ${url} -H "Content-Type: application/json"${auth} -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

Search (fill in only what the traveller said):
curl -s ${url} -H "Content-Type: application/json"${auth} -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_flights","arguments":{"origin":{"places":["Orlando"]},"destination":{"places":["Washington DC"]},"oneWay":true,"departEarliest":{"kind":"absolute","date":"${day}"},"departLatest":{"kind":"absolute","date":"${day}"}}}}'

A search can take a minute or two. If details are missing it returns questions to ask the traveller instead of searching (nothing is counted). Results include results_url, the full results page to give the traveller, and a book_url for each flight they can book.
`;
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
