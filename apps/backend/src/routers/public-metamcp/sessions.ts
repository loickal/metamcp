import { buildAdminToolsOptions } from "../../lib/admin-mcp/build-admin-tools-options";
import { createMcpSessionHandler } from "../../lib/mcp-session-handler";
import { extractClientHeaders } from "../../lib/metamcp/header-forwarding";
import { metaMcpServerPool } from "../../lib/metamcp/metamcp-server-pool";
import type { ApiKeyAuthenticatedRequest } from "../../middleware/api-key-oauth.middleware";

export const publicSessions = createMcpSessionHandler(
  "public",
  async (req, id) => {
    const auth = req as ApiKeyAuthenticatedRequest;
    const instance = await metaMcpServerPool.getServer(
      id,
      auth.namespaceUuid,
      false,
      extractClientHeaders(req.headers),
      await buildAdminToolsOptions(auth.endpoint, auth),
      {
        endpointName: auth.endpointName,
        auth: {
          method: auth.authMethod || "none",
          apiKeyUuid: auth.apiKeyUuid,
          apiKeyUserId: auth.apiKeyUserId,
          oauthUserId: auth.oauthUserId,
        },
      },
    );
    if (!instance) throw new Error("MCP server unavailable");
    return {
      server: instance.server,
      cleanup: () => metaMcpServerPool.cleanupSession(id),
    };
  },
);
