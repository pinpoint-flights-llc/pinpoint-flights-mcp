import { NextRequest } from "next/server";
import { verifyKey } from "@/lib/mcp/keys";
import { guide, postOnly, serve } from "@/lib/mcp/serve";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /mcp/<key>: the Pinpoint Flights MCP server (src/lib/mcp), for Claude, ChatGPT and other assistants. The key
 * comes from /connect and is what the daily search allowance is counted against. Not behind the geo gate (the caller
 * is the assistant's server, not the traveller); /connect, where keys are handed out, is.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const keyId = verifyKey(key);
  if (!keyId) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unknown connector key. Get your own connector URL at https://pinpoint.flights/connect" } }, { status: 404 });
  return serve(req, keyId);
}

/** The link opened rather than connected to: how to use it (src/lib/mcp/serve.ts). A bad key gets the same 404 as a POST. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!verifyKey(key)) return new Response("Unknown connector key. Get your own connector link at https://pinpoint.flights/connect\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return guide(req, true);
}
export const DELETE = postOnly;
