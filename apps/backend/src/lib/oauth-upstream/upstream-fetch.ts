import { oauthSessionsRepository } from "../../db/repositories";
import { tryRefreshUpstreamTokens } from "./refresh-on-401";
import { safeOAuthFetch } from "./safe-fetch";

// Used by both inspector transports and pooled MCP clients. Identity comes
// exclusively from authenticated backend context, never from a request field.
export function createUpstreamFetch(
  server: { uuid: string; name: string; url: string },
  userId?: string,
): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.origin !== new URL(server.url).origin)
      throw new Error("Cross-origin MCP transport destination rejected");
    const session = userId
      ? await oauthSessionsRepository.findByMcpServerUuid(server.uuid, userId)
      : undefined;
    const tokens =
      session?.client_information?.server_url === server.url
        ? session.tokens
        : null;
    const headers = new Headers(init.headers);
    if (tokens?.access_token)
      headers.set("Authorization", `Bearer ${tokens.access_token}`);
    const send = () =>
      (tokens ? safeOAuthFetch : fetch)(url, {
        ...init,
        headers,
        redirect: "error",
        signal: init.signal ?? new AbortController().signal,
      });
    let response = await send();
    if (response.status === 401 && tokens?.refresh_token && userId) {
      const refreshed = await tryRefreshUpstreamTokens({
        ...server,
        oauth_user_id: userId,
      });
      if (refreshed.status === "refreshed" && refreshed.tokens) {
        await response.body?.cancel();
        headers.set("Authorization", `Bearer ${refreshed.tokens.access_token}`);
        response = await send();
      }
    }
    return response;
  };
}
