// Server-side refresh grants. The in-process mutex is scoped to user + server;
// tokens and client configuration are read and written with the same identity.
// Multi-replica refresh serialization remains a deployment limitation.

import { ServerParameters } from "@repo/zod-types";

import { oauthSessionsRepository } from "../../db/repositories";
import logger from "../../utils/logger";
import {
  OAuthTokens,
  refreshAccessToken,
  resolveTokenEndpointAuthMethod,
  UpstreamTokenError,
} from "./token-exchange";

export interface RefreshResult {
  status:
    | "refreshed"
    | "no_refresh_token"
    | "no_session"
    | "no_client_id"
    | "failed";
  tokens?: OAuthTokens;
  error?: string;
  errorDescription?: string;
  upstreamStatus?: number;
}

// Per-server in-flight refresh promises. Concurrent callers for the same
// MCP server share the same upstream POST instead of racing on rotating
// refresh tokens. The map is cleared in a `finally` so a refresh failure
// doesn't permanently pin the server. Exposed for tests; do not depend on
// it from production code.
export const inFlightRefreshes = new Map<string, Promise<RefreshResult>>();

// Attempt to refresh upstream OAuth tokens for an MCP server. Returns a
// status describing what happened. Persists new tokens on success.
//
// NOTE: This is intentionally safe to call repeatedly — it short-circuits
// when there is no refresh_token or no client_id to use.
export async function tryRefreshUpstreamTokens(
  serverParams: Pick<
    ServerParameters,
    "uuid" | "name" | "url" | "oauth_user_id"
  >,
): Promise<RefreshResult> {
  if (!serverParams.oauth_user_id) return { status: "no_session" };
  const key = JSON.stringify([serverParams.oauth_user_id, serverParams.uuid]);
  const inFlight = inFlightRefreshes.get(key);
  if (inFlight) {
    logger.info(
      `[oauth] refresh already in flight for ${serverParams.uuid}; joining`,
    );
    return inFlight;
  }
  const promise = (async () => {
    try {
      return await doRefresh(serverParams);
    } finally {
      inFlightRefreshes.delete(key);
    }
  })();
  inFlightRefreshes.set(key, promise);
  return promise;
}

async function doRefresh(
  serverParams: Pick<
    ServerParameters,
    "uuid" | "name" | "url" | "oauth_user_id"
  >,
): Promise<RefreshResult> {
  if (!serverParams.url || !serverParams.oauth_user_id) {
    return { status: "no_session" };
  }

  const session = await oauthSessionsRepository.findByMcpServerUuid(
    serverParams.uuid,
    serverParams.oauth_user_id,
  );
  if (!session) {
    return { status: "no_session" };
  }

  const currentTokens = session.tokens as
    | (OAuthTokens & { refresh_token?: string })
    | null;
  if (!currentTokens?.refresh_token) {
    return { status: "no_refresh_token" };
  }

  const clientInformation = session.client_information as Record<
    string,
    unknown
  > | null;
  const clientId =
    clientInformation && typeof clientInformation.client_id === "string"
      ? (clientInformation.client_id as string)
      : null;
  if (!clientId) {
    return { status: "no_client_id" };
  }
  const clientSecret =
    typeof clientInformation?.client_secret === "string"
      ? (clientInformation.client_secret as string)
      : undefined;

  if (
    clientInformation?.server_url !== serverParams.url ||
    typeof clientInformation?.token_endpoint !== "string"
  ) {
    return { status: "no_session" };
  }
  const tokenEndpoint = clientInformation.token_endpoint;
  const authMethod = resolveTokenEndpointAuthMethod({
    clientInformation,
    discovered: null,
    hasSecret: Boolean(clientSecret),
  });

  let newTokens: OAuthTokens;
  try {
    newTokens = await refreshAccessToken({
      tokenEndpoint,
      resource:
        typeof clientInformation.resource === "string"
          ? clientInformation.resource
          : undefined,
      refreshToken: currentTokens.refresh_token,
      clientId,
      clientSecret,
      authMethod,
      scope:
        typeof currentTokens.scope === "string"
          ? currentTokens.scope
          : undefined,
    });
  } catch (error) {
    if (error instanceof UpstreamTokenError) {
      logger.warn(
        `[oauth] proxy refresh failed — server=${serverParams.uuid} ` +
          `status=${error.status}`,
      );
      return {
        status: "failed",
        error: error.oauthError?.error ?? "upstream_error",
        errorDescription: "OAuth refresh failed",
        upstreamStatus: error.status,
      };
    }
    logger.warn(`[oauth] proxy refresh failed — server=${serverParams.uuid}`);
    return {
      status: "failed",
      error: "refresh_failed",
    };
  }

  await oauthSessionsRepository.upsert({
    mcp_server_uuid: serverParams.uuid,
    user_id: serverParams.oauth_user_id,
    tokens: newTokens,
  });

  return { status: "refreshed", tokens: newTokens };
}
