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
