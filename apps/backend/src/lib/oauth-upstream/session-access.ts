import type { NextFunction, Request, Response } from "express";

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
      const id = req.get("mcp-session-id") ?? req.query.sessionId;
      if (id && (typeof id !== "string" || owners.get(id) !== principal(req))) {
        res.status(404).end("Session not found");
        return;
      }
      next();
    },
  };
}
