import express from "express";

import { namespacesRepository } from "../../db/repositories/namespaces.repo";
import { mcpRequestContext } from "../../lib/mcp-diagnostics";
import { createMcpSessionHandler } from "../../lib/mcp-session-handler";
import { createServer } from "../../lib/metamcp/index";
import { betterAuthMcpMiddleware } from "../../middleware/better-auth-mcp.middleware";

const metamcpRouter = express.Router();
metamcpRouter.use(mcpRequestContext, betterAuthMcpMiddleware);
const sessions = createMcpSessionHandler("inspector", async (req, id) =>
  createServer(
    req.params.uuid,
    id,
    req.query.includeInactiveServers === "true",
    undefined,
    {
      endpointName: "inspector",
      auth: {
        method: "none",
        sessionUserId: (req as express.Request & { user: { id: string } }).user
          .id,
      },
    },
  ),
);
metamcpRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "metamcp" });
});
metamcpRouter.get("/info", (_req, res) => {
  res.json({
    service: "metamcp",
    version: "1.0.0",
    description: "MetaMCP unified MCP proxy service",
  });
});
// Mount at a parameterized path: router-wide middleware has no req.params.uuid.
metamcpRouter.use(
  "/:uuid",
  async (req, res, next) => {
    const userId = (req as express.Request & { user: { id: string } }).user.id;
    try {
      const namespace = await namespacesRepository.findByUuid(req.params.uuid);
      if (!namespace || (namespace.user_id && namespace.user_id !== userId)) {
        res.status(404).end("Namespace not found");
        return;
      }
      next();
    } catch {
      res.status(503).end("Namespace unavailable");
    }
  },
  sessions.check,
);
metamcpRouter.all("/:uuid/mcp", sessions.http);
metamcpRouter.get(
  "/:uuid/sse",
  sessions.sse((req) => `/mcp-proxy/metamcp/${req.params.uuid}/message`),
);
metamcpRouter.post("/:uuid/message", sessions.message);
export default metamcpRouter;
