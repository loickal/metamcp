import { SESSION_KEYS } from "./constants";
import { vanillaTrpcClient } from "./trpc";

// The browser only navigates to the authorization endpoint and relays the
// callback. Discovery, registration, PKCE and tokens stay on the backend.
export async function beginOAuth(mcpServerUuid: string, serverUrl: string) {
  const result = await vanillaTrpcClient.frontend.oauth.begin.mutate({
    mcp_server_uuid: mcpServerUuid,
  });
  sessionStorage.setItem(SESSION_KEYS.MCP_SERVER_UUID, mcpServerUuid);
  sessionStorage.setItem(SESSION_KEYS.SERVER_URL, serverUrl);
  window.location.assign(result.authorization_url);
}
