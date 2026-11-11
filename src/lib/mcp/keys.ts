import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Connector keys: what the 7-a-day search allowance is counted against. A request to the MCP endpoint comes from the
 * AI company's servers (Anthropic, OpenAI), not the traveller's browser, so its IP says nothing about who is asking;
 * the key in the connector URL (/mcp/<key>) does. A key is a random id plus an HMAC of it, so nothing is stored to
 * hand one out or to check one: /connect mints them (geo-gated and capped per IP), the endpoint verifies them.
 */
const ID_BYTES = 9; // 12 base64url chars
const SIG_CHARS = 16;

function sign(id: string): string {
  return createHmac("sha256", env.mcpKeySecret).update(`mcp-key:${id}`).digest("base64url").slice(0, SIG_CHARS);
}

export function mintKey(): string {
  const id = randomBytes(ID_BYTES).toString("base64url");
  return id + sign(id);
}

/** The key's id when it is genuine, else null. The id is what usage is logged and counted under. */
export function verifyKey(key: string): string | null {
  if (!env.mcpKeySecret || !/^[A-Za-z0-9_-]{28}$/.test(key)) return null;
  const id = key.slice(0, 12), sig = key.slice(12);
  const want = sign(id);
  return timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? id : null;
}
