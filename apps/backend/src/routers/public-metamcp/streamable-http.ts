import express from "express";

import { authenticateApiKey } from "@/middleware/api-key-oauth.middleware";
import { lookupEndpoint } from "@/middleware/lookup-endpoint-middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

import { mcpRequestContext } from "../../lib/mcp-diagnostics";
import { publicSessions } from "./sessions";
const streamableHttpRouter = express.Router();
streamableHttpRouter.get("/health/sessions", (_req, res) => {
  res.json(publicSessions.stats());
});
streamableHttpRouter.all(
  "/:endpoint_name/mcp",
  mcpRequestContext,
  lookupEndpoint,
  authenticateApiKey,
  publicSessions.check,
  rateLimitMiddleware,
  publicSessions.http,
);
export default streamableHttpRouter;
