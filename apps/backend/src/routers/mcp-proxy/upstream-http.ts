import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { TRPCError } from "@trpc/server";
import express from "express";

import { transformDockerUrl } from "../../lib/metamcp/transport-url";
import { requireOAuthServer } from "../../lib/oauth-upstream/access";
import { createUpstreamFetch } from "../../lib/oauth-upstream/upstream-fetch";

// Keep upstream session IDs private and bind every local session to a user and
// server. Forward the upstream HTTP status and WWW-Authenticate unchanged:
// the SDK otherwise turns initialize-time 401s into opaque JSON-RPC errors.
export const upstreamHttpRouter = express.Router();
const sessions = new Map<
  string,
  { user: string; server: string; upstream: string; touched: number }
>();
const expiry = 60 * 60_000;
const timer = setInterval(() => {
  for (const [id, session] of sessions)
    if (Date.now() - session.touched > expiry) sessions.delete(id);
}, 60_000);
timer.unref();

upstreamHttpRouter.all(
  "/mcp",
  express.raw({ type: () => true, limit: "10mb" }),
  async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const user = (req as express.Request & { user?: { id: string } }).user
        ?.id;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const serverId =
        typeof req.query.mcpServerUuid === "string"
          ? req.query.mcpServerUuid
          : "";
      if (!/^[0-9a-f-]{36}$/i.test(serverId)) {
        res.status(400).json({ error: "MCP server UUID required" });
        return;
      }
      const server = await requireOAuthServer(serverId, user);
      if (server.type !== "STREAMABLE_HTTP") {
        res.status(400).end();
        return;
      }
      const localId = req.get("mcp-session-id");
      const session = localId ? sessions.get(localId) : undefined;
      if (
        localId &&
        (!session || session.user !== user || session.server !== serverId)
      ) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session) session.touched = Date.now();
      const headers = new Headers(server.headers ?? {});
      for (const name of [
        "accept",
        "content-type",
        "mcp-protocol-version",
        "last-event-id",
      ]) {
        const value = req.get(name);
        if (value) headers.set(name, value);
      }
      const manualAuthorization = req.get("authorization");
      if (server.bearerToken)
        headers.set("Authorization", `Bearer ${server.bearerToken}`);
      else if (manualAuthorization)
        headers.set("Authorization", manualAuthorization);
      if (session) headers.set("mcp-session-id", session.upstream);
      const transportUrl = transformDockerUrl(server.url);
      const response = await createUpstreamFetch(
        server,
        user,
        transportUrl,
      )(transportUrl, {
        method: req.method,
        headers,
        signal: controller.signal,
        ...(req.method === "POST" && {
          body: Buffer.isBuffer(req.body)
            ? req.body.toString("utf8")
            : JSON.stringify(req.body),
        }),
      });
      res.status(response.status);
      res.setHeader("Cache-Control", "no-store");
      for (const name of [
        "content-type",
        "www-authenticate",
        "mcp-protocol-version",
        "retry-after",
      ]) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      const upstreamId = response.headers.get("mcp-session-id");
      if (response.ok && upstreamId) {
        const id = localId ?? randomUUID();
        sessions.set(id, {
          user,
          server: serverId,
          upstream: upstreamId,
          touched: Date.now(),
        });
        res.setHeader("mcp-session-id", id);
      }
      if (localId && (req.method === "DELETE" || response.status === 404))
        sessions.delete(localId);
      if (response.body) {
        const stream = Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        );
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      } else res.end();
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res
        .status(
          error instanceof TRPCError && error.code === "NOT_FOUND" ? 404 : 502,
        )
        .json({ error: "Unable to connect to MCP server" });
    }
  },
);
