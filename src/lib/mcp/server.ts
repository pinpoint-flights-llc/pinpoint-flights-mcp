import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTION, inputSchema, searchFlights, type Caller } from "./search";

/**
 * A Model Context Protocol server over Streamable HTTP, stateless, answering every POST with one JSON body (no SSE
 * stream, no session id): the protocol allows it, and a search is one request and one answer. Small enough to keep in
 * our own code rather than pull in the SDK. Spec: https://modelcontextprotocol.io/specification
 */
/** Keep equal to "version" in server.json (the MCP Registry manifest): each publish there needs a new one. */
export const VERSION = "1.1.1";
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** What a search says when the caller has no connector key yet. Written for the assistant to pass on. */
export const NEEDS_KEY = "Searching needs the traveller's own free connector key. Tell them to get one at https://pinpoint.flights/connect, then either use the personal link it gives them as this connector's URL, or send the key (the last part of that link) as the header \"Authorization: Bearer <key>\".";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };
export type RpcReply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const TOOLS = [
  {
    name: "search_flights",
    title: "Search flights",
    description: TOOL_DESCRIPTION,
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

/** One JSON-RPC message in, its reply out (null for a notification, which gets none). */
export async function handle(msg: Rpc, caller: Caller): Promise<RpcReply | null> {
  if (msg.id === undefined || msg.id === null) return null;
  const ok = (result: unknown): RpcReply => ({ jsonrpc: "2.0", id: msg.id!, result });
  const fail = (code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id: msg.id!, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: {
          name: "pinpoint-flights", title: "Pinpoint Flights", version: VERSION, websiteUrl: caller.siteOrigin,
          description: "Flight search with very deep filters: exact time windows, nonstop vs. price trade-offs, bags, fare rules, flexible dates and several destinations at once.",
          icons: [{ src: `${caller.siteOrigin}/logo.png`, mimeType: "image/png", sizes: ["512x512"] }],
        },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      if (name !== "search_flights") return fail(-32602, `Unknown tool: ${String(name)}`);
      // Connected without a key (/mcp with no Authorization header): looking is free, searching needs the allowance.
      if (!caller.keyId) return ok({ content: [{ type: "text", text: NEEDS_KEY }], isError: true });
      const { result, isError } = await searchFlights(msg.params?.arguments ?? {}, caller);
      return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: Boolean(isError) });
    }
    default:
      return fail(-32601, `Method not found: ${String(msg.method)}`);
  }
}
