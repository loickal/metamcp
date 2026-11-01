import { DatabaseOAuthSession } from "@repo/zod-types";

export class OAuthSessionsSerializer {
  static serializeOAuthSession(session: DatabaseOAuthSession) {
    const ci = session.client_information;
    // Explicit allowlist: registration access tokens, secrets, PKCE and
    // upstream tokens must never reach the browser, even for the owner.
    const client_information = ci
      ? (Object.fromEntries(
          [
            "client_id",
            "scope",
            "authorization_endpoint",
            "token_endpoint",
            "token_endpoint_auth_method",
          ]
            .filter((key) => typeof ci[key] === "string")
            .map((key) => [key, ci[key]]),
        ) as { client_id: string })
      : null;
    return {
      uuid: session.uuid,
      mcp_server_uuid: session.mcp_server_uuid,
      client_information,
      connected: Boolean(session.tokens?.access_token),
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
    };
  }
}
