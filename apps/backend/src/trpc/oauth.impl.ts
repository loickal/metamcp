import { createHash, randomBytes } from "node:crypto";

import { OAuthClientInformationFullSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  BeginOAuthRequestSchema,
  ExchangeOAuthTokenRequestSchema,
  GetOAuthSessionRequestSchema,
  RefreshOAuthTokenRequestSchema,
  UpsertOAuthSessionRequestSchema,
} from "@repo/zod-types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { oauthSessionsRepository } from "../db/repositories";
import { OAuthSessionsSerializer } from "../db/serializers";
import { requireOAuthServer } from "../lib/oauth-upstream/access";
import { discoverUpstreamOAuth } from "../lib/oauth-upstream/discovery";
import { tryRefreshUpstreamTokens } from "../lib/oauth-upstream/refresh-on-401";
import {
  readOAuthJson,
  safeOAuthFetch,
  validateOAuthUrl,
} from "../lib/oauth-upstream/safe-fetch";
import {
  exchangeAuthorizationCode,
  resolveTokenEndpointAuthMethod,
} from "../lib/oauth-upstream/token-exchange";
import { resolveRedirectUri } from "./pre-registered-oauth";

export const oauthImplementations = {
  get: async (
    input: z.infer<typeof GetOAuthSessionRequestSchema>,
    userId: string,
  ) => {
    await requireOAuthServer(input.mcp_server_uuid, userId);
    const session = await oauthSessionsRepository.findByMcpServerUuid(
      input.mcp_server_uuid,
      userId,
    );
    if (!session)
      return { success: false as const, message: "OAuth session not found" };
    return {
      success: true as const,
      data: OAuthSessionsSerializer.serializeOAuthSession(session),
      message: "OAuth session retrieved",
    };
  },

  upsert: async (
    input: z.infer<typeof UpsertOAuthSessionRequestSchema>,
    userId: string,
  ) => {
    const server = await requireOAuthServer(input.mcp_server_uuid, userId);
    const supplied = input.client_information;
    const ci: Record<string, unknown> & { client_id: string } = {
      client_id: supplied.client_id,
    };
    for (const field of [
      "client_secret",
      "scope",
      "authorization_endpoint",
      "token_endpoint",
      "token_endpoint_auth_method",
    ]) {
      if (typeof supplied[field] === "string") ci[field] = supplied[field];
    }
    for (const field of ["authorization_endpoint", "token_endpoint"]) {
      if (typeof ci[field] === "string") await validateOAuthUrl(ci[field]);
    }
    const existing = await oauthSessionsRepository.findByMcpServerUuid(
      server.uuid,
      userId,
    );
    if (
      !ci.client_secret &&
      existing?.client_information?.client_id === ci.client_id
    ) {
      ci.client_secret = existing.client_information.client_secret;
    }
    const session = await oauthSessionsRepository.upsert({
      mcp_server_uuid: server.uuid,
      user_id: userId,
      client_information: {
        ...ci,
        pre_registered: true,
        server_url: server.url,
      },
      tokens: null,
      code_verifier: null,
      expected_state: null,
      flow_expires_at: null,
    });
    return {
      success: true as const,
      data: OAuthSessionsSerializer.serializeOAuthSession(session),
      message: "OAuth client saved",
    };
  },

  begin: async (
    input: z.infer<typeof BeginOAuthRequestSchema>,
    userId: string,
  ) => {
    const server = await requireOAuthServer(input.mcp_server_uuid, userId);
    try {
      const redirectUri = resolveRedirectUri();
      const session = await oauthSessionsRepository.findByMcpServerUuid(
        server.uuid,
        userId,
      );
      let ci = session?.client_information;
      // Never send an existing client's credentials to a changed server/issuer.
      if (ci?.server_url !== server.url) ci = null;
      const configured =
        ci?.pre_registered === true &&
        typeof ci.authorization_endpoint === "string" &&
        typeof ci.token_endpoint === "string";
      const discovery = configured
        ? undefined
        : await discoverUpstreamOAuth(server.url);
      const metadata = discovery?.metadata;
      if (ci && !ci.pre_registered && ci.issuer !== metadata?.issuer) ci = null;
      const authorizationEndpoint = configured
        ? (ci!.authorization_endpoint as string)
        : metadata!.authorization_endpoint;
      const tokenEndpoint = configured
        ? (ci!.token_endpoint as string)
        : metadata!.token_endpoint;
      if (!tokenEndpoint) throw new Error("Missing token endpoint");
      await validateOAuthUrl(server.url);
      await validateOAuthUrl(authorizationEndpoint);
      await validateOAuthUrl(tokenEndpoint);
      const resource = discovery?.resource ?? server.url;
      const scope =
        typeof ci?.scope === "string" && ci.scope ? ci.scope : discovery?.scope;
      if (!ci?.client_id) {
        if (!metadata?.registration_endpoint) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This OAuth server requires a pre-registered client. Configure its client ID in Advanced OAuth.",
          });
        }
        const response = await safeOAuthFetch(metadata.registration_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_name: "MetaMCP",
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            ...(scope && { scope }),
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Dynamic registration was rejected. Configure a pre-registered OAuth client in Advanced OAuth.",
          });
        }
        const registered = OAuthClientInformationFullSchema.parse(
          await readOAuthJson(response),
        );
        ci = registered;
        if (!registered.redirect_uris.includes(redirectUri))
          throw new Error("Registration redirect mismatch");
      }
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const authorizationUrl = new URL(authorizationEndpoint);
      const params = {
        response_type: "code",
        client_id: ci.client_id,
        redirect_uri: redirectUri,
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        resource,
      };
      for (const [key, value] of Object.entries(params))
        authorizationUrl.searchParams.set(key, value);
      if (scope) authorizationUrl.searchParams.set("scope", scope);
      await oauthSessionsRepository.upsert({
        mcp_server_uuid: server.uuid,
        user_id: userId,
        client_information: {
          ...ci,
          server_url: server.url,
          issuer: metadata?.issuer,
          authorization_endpoint: authorizationEndpoint,
          token_endpoint: tokenEndpoint,
          resource,
          redirect_uri: redirectUri,
          token_endpoint_auth_method: resolveTokenEndpointAuthMethod({
            clientInformation: ci,
            discovered: metadata ?? null,
            hasSecret: Boolean(ci.client_secret),
          }),
        },
        tokens: null,
        code_verifier: verifier,
        expected_state: state,
        flow_expires_at: new Date(Date.now() + 10 * 60_000),
      });
      return { authorization_url: authorizationUrl.href };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "OAuth discovery or registration failed. Check that the server publishes valid HTTPS OAuth metadata and supports PKCE S256.",
      });
    }
  },

  exchangeToken: async (
    input: z.infer<typeof ExchangeOAuthTokenRequestSchema>,
    userId: string,
  ) => {
    const server = await requireOAuthServer(input.mcp_server_uuid, userId);
    if (!input.state)
      return { success: false as const, error: "invalid_state" };
    const session = await oauthSessionsRepository.consumeState(
      server.uuid,
      userId,
      input.state,
    );
    if (!session?.code_verifier)
      return {
        success: false as const,
        error: "invalid_state",
        error_description:
          "The OAuth flow expired or was already used. Start authorization again.",
      };
    const ci = session.client_information;
    if (
      !ci?.client_id ||
      ci.server_url !== server.url ||
      typeof ci.token_endpoint !== "string" ||
      typeof ci.redirect_uri !== "string"
    ) {
      return { success: false as const, error: "invalid_session" };
    }
    try {
      const tokens = await exchangeAuthorizationCode({
        tokenEndpoint: ci.token_endpoint,
        code: input.code,
        codeVerifier: session.code_verifier,
        redirectUri: ci.redirect_uri,
        clientId: ci.client_id,
        clientSecret: ci.client_secret,
        authMethod: resolveTokenEndpointAuthMethod({
          clientInformation: ci,
          discovered: null,
          hasSecret: Boolean(ci.client_secret),
        }),
        resource: typeof ci.resource === "string" ? ci.resource : undefined,
      });
      await oauthSessionsRepository.upsert({
        mcp_server_uuid: server.uuid,
        user_id: userId,
        tokens,
        code_verifier: null,
      });
      return { success: true as const, message: "OAuth tokens persisted" };
    } catch {
      return {
        success: false as const,
        error: "token_exchange_failed",
        error_description:
          "OAuth token exchange failed. Start authorization again.",
      };
    }
  },

  refreshToken: async (
    input: z.infer<typeof RefreshOAuthTokenRequestSchema>,
    userId: string,
  ) => {
    const server = await requireOAuthServer(input.mcp_server_uuid, userId);
    const result = await tryRefreshUpstreamTokens({
      uuid: server.uuid,
      name: server.name,
      url: server.url,
      oauth_user_id: userId,
    });
    return result.status === "refreshed"
      ? { success: true as const, message: "OAuth tokens refreshed" }
      : {
          success: false as const,
          error: "refresh_failed",
          error_description: "Re-authorize this MCP server.",
        };
  },
};
