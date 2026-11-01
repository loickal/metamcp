import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

import type { RequestHandler } from "express";

import logger from "@/utils/logger";

export const bootId = randomUUID();
const requests = new AsyncLocalStorage<{ requestId: string }>();
const counters: Record<string, number> = {};
export const mcpRequestContext: RequestHandler = (_req, res, next) => {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-MetaMCP-Instance", bootId);
  requests.run({ requestId }, next);
};
// Only bounded event/reason names and non-secret metadata. No headers, tool
// arguments, provider errors, user identifiers or raw session IDs.
export function mcpEvent(
  event: string,
  fields: Record<string, string | number | undefined> = {},
  sessionId?: string,
) {
  counters[event] = (counters[event] ?? 0) + 1;
  if (event !== "session_reused" || counters[event] === 1) {
    logger.info(
      JSON.stringify({
        event,
        bootId,
        ...requests.getStore(),
        ...fields,
        session: sessionId
          ? createHash("sha256")
              .update(bootId + sessionId)
              .digest("hex")
              .slice(0, 12)
          : undefined,
      }),
    );
  }
}
export const mcpCounters = () => ({ bootId, counters: { ...counters } });
