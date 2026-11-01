import { randomUUID } from "node:crypto";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, RequestHandler } from "express";

import { mcpCounters, mcpEvent } from "./mcp-diagnostics";
import { createSessionAccess } from "./oauth-upstream/session-access";
import { SessionLifetimeManagerImpl } from "./session-lifetime-manager";

type Instance = { server: Server; cleanup: () => Promise<void> };
type Session = {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  instance?: Instance;
};

// Both public endpoints and the Inspector use the same lifecycle. HTTP response
// completion only ends a request; a legacy SSE disconnect ends that session.
export function createMcpSessionHandler(
  name: string,
  create: (req: Request, id: string) => Promise<Instance>,
) {
  const access = createSessionAccess();
  const sessions = new SessionLifetimeManagerImpl<Session>(name);
  const dispose = async (id: string, session: Session) => {
    access.remove(id);
    try {
      await session.transport.close();
    } finally {
      await session.instance?.cleanup();
    }
  };
  const close = (id: string, reason: string) =>
    sessions.close(id, dispose, reason);
  sessions.startCleanupTimer(dispose);
  const watchTransport = (id: string, session: Session) => {
    const onclose = session.transport.onclose;
    session.transport.onclose = () => {
      onclose?.();
      void close(id, "transport_closed").catch(() =>
        mcpEvent("session_cleanup_failed", {}, id),
      );
    };
    const onerror = session.transport.onerror;
    session.transport.onerror = (error) => {
      // SDK onerror also reports malformed individual requests. Only an actual
      // transport close terminates the session; a bad request must not do so.
      onerror?.(error);
      mcpEvent("transport_error", {}, id);
    };
  };
  const http: RequestHandler = async (req, res) => {
    const existing = req.get("mcp-session-id");
    let id = existing;
    try {
      if (req.method === "DELETE") {
        if (!id) {
          res.status(400).end("Missing session ID");
          return;
        }
        if (!sessions.getSession(id)) {
          mcpEvent("session_miss", {}, id);
          res.status(404).end("Session not found");
          return;
        }
        await close(id, "explicit_delete");
        res.status(200).end();
        return;
      }
      let session = id ? sessions.getSession(id) : undefined;
      if (!session && (id || req.method !== "POST")) {
        mcpEvent("session_miss", {}, id);
        res.status(404).end("Session not found");
        return;
      }
      if (!session) {
        id = randomUUID();
        const newId = id;
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
          sessionIdGenerator: () => newId,
          onsessioninitialized: () => {
            access.bind(newId, req);
            sessions.activate(newId);
          },
        });
        session = { transport };
        sessions.addSession(id, session, "INITIALIZING");
        const initial = session;
        await sessions.run(id, async () => {
          initial.instance = await create(req, newId);
          await initial.instance.server.connect(transport);
          watchTransport(newId, initial);
        });
        mcpEvent(
          "session_bound",
          {
            namespace:
              req.params.uuid ??
              (req as Request & { namespaceUuid?: string }).namespaceUuid,
            endpoint: req.params.endpoint_name ?? name,
          },
          id,
        );
      } else {
        mcpEvent("session_reused", {}, id);
      }
      if (!(session.transport instanceof StreamableHTTPServerTransport)) {
        res.status(400).end("Wrong transport");
        return;
      }
      // Retain compatibility with clients that send only application/json.
      req.headers.accept = "application/json, text/event-stream";
      const transport = session.transport;
      if (!id) throw new Error("Missing session ID");
      // A GET may keep an SSE stream open indefinitely. It is not an RPC and
      // must not hold the drain barrier that DELETE waits for.
      if (req.method === "GET") await transport.handleRequest(req, res);
      else
        await sessions.run(id, () =>
          transport.handleRequest(req, res, req.body),
        );
      if (!existing && sessions.getState(id) === "INITIALIZING")
        await close(id, "initialization_failed");
    } catch {
      if (!existing && id)
        await close(id, "initialization_failed").catch(() => {});
      mcpEvent("session_request_failed", {}, id);
      if (!res.headersSent)
        res
          .status(503)
          .json({ error: "MCP session unavailable; initialize a new session" });
    }
  };
  const sse =
    (messagePath: (req: Request) => string): RequestHandler =>
    async (req, res) => {
      const transport = new SSEServerTransport(messagePath(req), res);
      const id = transport.sessionId;
      const session: Session = { transport };
      try {
        sessions.addSession(id, session, "INITIALIZING");
        res.once("close", () => {
          void close(id, "sse_disconnected").catch(() =>
            mcpEvent("session_cleanup_failed", {}, id),
          );
        });
        await sessions.run(id, async () => {
          session.instance = await create(req, id);
          // start() publishes the message URL. Bind before it, but requests cannot
          // use the transport until connect has completed and state is ACTIVE.
          access.bind(id, req);
          await session.instance.server.connect(transport);
          watchTransport(id, session);
          sessions.activate(id);
        });
      } catch {
        await close(id, "initialization_failed").catch(() => {});
        if (!res.headersSent) res.status(503).end("MCP session unavailable");
      }
    };
  const message: RequestHandler = async (req, res) => {
    const id =
      typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const session = sessions.getSession(id);
    if (!(session?.transport instanceof SSEServerTransport)) {
      mcpEvent("session_miss", {}, id);
      res.status(404).end("Session not found");
      return;
    }
    try {
      const transport = session.transport;
      await sessions.run(id, () => transport.handlePostMessage(req, res));
    } catch {
      if (!res.headersSent) res.status(500).end("MCP request failed");
    }
  };
  return {
    check: access.check,
    http,
    sse,
    message,
    stats: () => ({
      ...mcpCounters(),
      activeSessions: sessions.getSessionCount(),
    }),
  };
}
