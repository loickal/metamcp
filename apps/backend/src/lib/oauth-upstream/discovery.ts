import {
  buildDiscoveryUrls,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { readOAuthJson, safeOAuthFetch, validateOAuthUrl } from "./safe-fetch";

async function metadataAt(url: string | URL, fetchFn: typeof fetch) {
  await validateOAuthUrl(url);
  const response = await fetchFn(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("OAuth metadata request failed");
  }
  return readOAuthJson(response);
}

export async function discoverUpstreamOAuth(
  serverUrl: string,
  fetchFn = safeOAuthFetch,
) {
  const resource = new URL(serverUrl);
  await validateOAuthUrl(resource);
  // A credential-free request obtains the real challenge, including path-specific
  // metadata and scope. Never accept a metadata URL supplied by the browser.
  const probe = await fetchFn(resource, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "MetaMCP", version: "2.0.0" },
      },
    }),
  });
  const challenge =
    probe.status === 401 ? extractWWWAuthenticateParams(probe) : {};
  await probe.body?.cancel();
  const candidates = challenge.resourceMetadataUrl
    ? [challenge.resourceMetadataUrl]
    : [
        new URL(
          `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`,
          resource.origin,
        ),
        new URL("/.well-known/oauth-protected-resource", resource.origin),
      ];
  let protectedResource;
  for (const url of candidates) {
    const data = await metadataAt(url, fetchFn);
    if (data === undefined) continue;
    protectedResource = OAuthProtectedResourceMetadataSchema.parse(data);
    await validateOAuthUrl(protectedResource.resource);
    const declared = new URL(protectedResource.resource);
    if (
      declared.origin !== resource.origin ||
      declared.search ||
      declared.hash ||
      !(
        resource.pathname === declared.pathname ||
        resource.pathname.startsWith(declared.pathname.replace(/\/$/, "") + "/")
      )
    ) {
      throw new Error("OAuth protected resource does not match the MCP server");
    }
    break;
  }
  // Legacy MCP servers may publish AS metadata directly at the resource origin.
  if (protectedResource && !protectedResource.authorization_servers?.length)
    throw new Error("Missing authorization server");
  const issuer =
    protectedResource?.authorization_servers?.[0] ?? resource.origin;
  await validateOAuthUrl(issuer);
  if (new URL(issuer).search)
    throw new Error("OAuth issuer must not contain a query");
  for (const { url } of buildDiscoveryUrls(issuer)) {
    const data = await metadataAt(url, fetchFn);
    if (data === undefined) continue;
    const metadata = OAuthMetadataSchema.parse(data);
    if (metadata.issuer !== issuer) throw new Error("OAuth issuer mismatch");
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
    ]) {
      if (endpoint) await validateOAuthUrl(endpoint);
    }
    if (!metadata.code_challenge_methods_supported?.includes("S256")) {
      throw new Error("OAuth server must support PKCE S256");
    }
    return {
      metadata,
      resource: protectedResource?.resource ?? resource.href,
      scope: challenge.scope ?? protectedResource?.scopes_supported?.join(" "),
    };
  }
  throw new Error("OAuth authorization server metadata unavailable");
}
