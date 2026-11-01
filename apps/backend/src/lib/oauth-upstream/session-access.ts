import type { NextFunction, Request, Response } from "express";

import { mcpEvent } from "../mcp-diagnostics";

// Transport session IDs are not authorization credentials. Bind resumptions
// and deletes to the authenticated caller and configured endpoint too.
export function createSessionAccess() {
  const owners = new Map<string, string>();
  function principal(req: Request) {
    const auth = req as Request & {
      user?: { id: string };
      oauthUserId?: string;
      apiKeyUserId?: string;
      apiKeyUuid?: string;
      endpointName?: string;
    };
    return JSON.stringify([
      auth.user?.id ?? auth.oauthUserId ?? auth.apiKeyUserId ?? null,
      auth.apiKeyUuid ?? null,
      auth.endpointName ?? req.params.uuid ?? null,
      (req as Request & { namespaceUuid?: string }).namespaceUuid ?? null,
    ]);
  }
  return {
    bind(id: string, req: Request) {
      owners.set(id, principal(req));
    },
    remove(id: string) {
      owners.delete(id);
    },
    check(req: Request, res: Response, next: NextFunction) {
      const headerId = req.get("mcp-session-id");
      const queryId = req.query.sessionId;
      const id = headerId ?? queryId;
      if (
        (headerId && queryId && headerId !== queryId) ||
        (id && (typeof id !== "string" || owners.get(id) !== principal(req)))
      ) {
        mcpEvent(
          "session_miss",
          { namespace: req.params.uuid, endpoint: authEndpoint(req) },
          typeof id === "string" ? id : undefined,
        );
        res.status(404).end("Session not found");
        return;
      }
      next();
    },
  };
}

function authEndpoint(req: Request) {
  return (req as Request & { endpointName?: string }).endpointName;
}
