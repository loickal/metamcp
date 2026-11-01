import { OAuthClientInfoRequest } from "@repo/zod-types";

import { validateOAuthUrl } from "../lib/oauth-upstream/safe-fetch";
import type { OAuthSessionsRepository } from "../db/repositories/oauth-sessions.repo";

// Build the full `oauth_sessions.client_information` jsonb from
// user-supplied pre-registration fields. `redirect_uris` is derived
// server-side from APP_URL so the user cannot misconfigure MetaMCP's
// own callback path.
export function buildPreRegisteredClientInformation(
  oauth: OAuthClientInfoRequest,
  redirectUri: string,
): Record<string, unknown> | null {
  if (!oauth.client_id || oauth.client_id.trim() === "") {
    return null;
  }

  const clientInfo: Record<string, unknown> = {
    client_id: oauth.client_id.trim(),
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: oauth.token_endpoint_auth_method ?? "none",
  };

  if (oauth.client_secret && oauth.client_secret.trim() !== "") {
    clientInfo.client_secret = oauth.client_secret;
  }
  if (oauth.scope && oauth.scope.trim() !== "") {
    clientInfo.scope = oauth.scope.trim();
  }
  if (
    oauth.authorization_endpoint &&
    oauth.authorization_endpoint.trim() !== ""
  ) {
    clientInfo.authorization_endpoint = oauth.authorization_endpoint.trim();
  }
  if (oauth.token_endpoint && oauth.token_endpoint.trim() !== "") {
    clientInfo.token_endpoint = oauth.token_endpoint.trim();
  }

  return clientInfo;
}

// Resolve MetaMCP's own OAuth callback URL from APP_URL.
export function resolveRedirectUri(): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    throw new Error(
      "APP_URL environment variable is required to derive the OAuth callback URL",
    );
  }
  return `${appUrl.replace(/\/$/, "")}/fe-oauth/callback`;
}

// Persist (or wipe) the pre-registered OAuth client information attached to
// an MCP server. Called after a server upsert when the request includes the
// optional `oauth_client_info` block.
export async function persistPreRegisteredOAuthClient(
  mcpServerUuid: string,
  oauth: OAuthClientInfoRequest,
  repo: OAuthSessionsRepository,
  userId: string,
  serverUrl: string,
): Promise<void> {
  const clientInfo = buildPreRegisteredClientInformation(
    oauth,
    resolveRedirectUri(),
  );

  // If client_id is absent the section was effectively cleared by the user.
  // Drop any pre-registered session so the SDK falls back to dynamic
  // registration on the next authorize attempt.
  if (!clientInfo) {
    const existing = await repo.findByMcpServerUuid(mcpServerUuid, userId);
    if (existing) {
      await repo.deleteByMcpServerUuid(mcpServerUuid, userId);
    }
    return;
  }

  for (const field of ["authorization_endpoint", "token_endpoint"]) {
    if (typeof clientInfo[field] === "string")
      await validateOAuthUrl(clientInfo[field]);
  }
  const existing = await repo.findByMcpServerUuid(mcpServerUuid, userId);
  if (
    !clientInfo.client_secret &&
    existing?.client_information?.client_id === clientInfo.client_id
  ) {
    clientInfo.client_secret = existing?.client_information?.client_secret;
  }
  await repo.upsert({
    mcp_server_uuid: mcpServerUuid,
    user_id: userId,
    client_information: {
      ...clientInfo,
      client_id: clientInfo.client_id as string,
      pre_registered: true,
      server_url: serverUrl,
    },
    tokens: null,
    code_verifier: null,
    expected_state: null,
    flow_expires_at: null,
  });
}
