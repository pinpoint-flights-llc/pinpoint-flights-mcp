import { NextRequest } from "next/server";
import { verifyKey } from "@/lib/mcp/keys";
import { guide, postOnly, serve } from "@/lib/mcp/serve";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /mcp: the same MCP server at an address with no key in it, which is what the MCP Registry lists
 * (flights.pinpoint/pinpoint-flights, server.json). The connector key travels as `Authorization: Bearer <key>` (or
 * `X-API-Key`). Without one the server still connects and lists its tool, but a search answers with where to get a
 * key (src/lib/mcp/serve.ts). A key that is sent and is wrong is refused outright, so a typo isn't mistaken for
 * "no key". Not behind the geo gate, like /mcp/<key>.
 */
export async function POST(req: NextRequest) {
  const sent = (/^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? req.headers.get("x-api-key") ?? "").trim();
  if (!sent) return serve(req, null);
  const keyId = verifyKey(sent);
  if (!keyId) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unknown connector key. Get your own at https://pinpoint.flights/connect" } }, { status: 401 });
  return serve(req, keyId);
}

export function GET(req: NextRequest) {
  return guide(req, false);
}
export const DELETE = postOnly;
