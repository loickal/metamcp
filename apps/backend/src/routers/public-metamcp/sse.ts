import express from "express";

import { authenticateApiKey } from "@/middleware/api-key-oauth.middleware";
import { lookupEndpoint } from "@/middleware/lookup-endpoint-middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

import { mcpRequestContext } from "../../lib/mcp-diagnostics";
import { publicSessions } from "./sessions";
const sseRouter = express.Router();
const middleware = [
  mcpRequestContext,
  lookupEndpoint,
  authenticateApiKey,
  publicSessions.check,
  rateLimitMiddleware,
];
sseRouter.get(
  "/:endpoint_name/sse",
  ...middleware,
  publicSessions.sse((req) => `/metamcp/${req.params.endpoint_name}/message`),
);
sseRouter.post(
  "/:endpoint_name/message",
  ...middleware,
  publicSessions.message,
);
export default sseRouter;
