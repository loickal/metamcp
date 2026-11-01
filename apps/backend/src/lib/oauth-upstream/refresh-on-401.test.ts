import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/repositories", () => ({
  oauthSessionsRepository: { findByMcpServerUuid: vi.fn(), upsert: vi.fn() },
}));
vi.mock("./safe-fetch", () => ({
  safeOAuthFetch: vi.fn(),
  readOAuthJson: (r: Response) => r.json(),
}));
import { oauthSessionsRepository as repo } from "../../db/repositories";
import { inFlightRefreshes, tryRefreshUpstreamTokens } from "./refresh-on-401";
import { safeOAuthFetch } from "./safe-fetch";

const server = {
  uuid: "server",
  name: "test",
  url: "https://resource.example/mcp",
  oauth_user_id: "alice",
};
const session = (user: string) => ({
  client_information: {
    client_id: user,
    server_url: server.url,
    token_endpoint: "https://issuer.example/token",
  },
  tokens: {
    access_token: `${user}-old`,
    refresh_token: `${user}-refresh`,
    token_type: "Bearer",
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  inFlightRefreshes.clear();
});

describe("scoped refresh", () => {
  it("does not look up shared credentials for anonymous requests", async () => {
    expect(
      await tryRefreshUpstreamTokens({ ...server, oauth_user_id: undefined }),
    ).toEqual({ status: "no_session" });
    expect(repo.findByMcpServerUuid).not.toHaveBeenCalled();
  });
  it("coalesces refreshes only for the same user and retains omitted refresh tokens", async () => {
    vi.mocked(repo.findByMcpServerUuid).mockImplementation(
      async (_server, user) => session(user) as never,
    );
    vi.mocked(safeOAuthFetch).mockImplementation(async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const user = (init?.body as URLSearchParams).get("client_id");
      return new Response(
        JSON.stringify({ access_token: `${user}-new`, token_type: "Bearer" }),
      );
    });
    const results = await Promise.all([
      tryRefreshUpstreamTokens(server),
      tryRefreshUpstreamTokens(server),
      tryRefreshUpstreamTokens({ ...server, oauth_user_id: "bob" }),
    ]);
    expect(safeOAuthFetch).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.tokens?.access_token)).toEqual([
      "alice-new",
      "alice-new",
      "bob-new",
    ]);
    for (const user of ["alice", "bob"])
      expect(repo.upsert).toHaveBeenCalledWith({
        mcp_server_uuid: "server",
        user_id: user,
        tokens: {
          access_token: `${user}-new`,
          refresh_token: `${user}-refresh`,
          token_type: "Bearer",
        },
      });
    expect(inFlightRefreshes.size).toBe(0);
  });
  it("persists rotated refresh tokens and releases failed refresh locks", async () => {
    vi.mocked(repo.findByMcpServerUuid).mockResolvedValue(
      session("alice") as never,
    );
    vi.mocked(safeOAuthFetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new",
            refresh_token: "rotated",
            token_type: "Bearer",
          }),
        ),
      );
    expect((await tryRefreshUpstreamTokens(server)).status).toBe("failed");
    expect(repo.upsert).not.toHaveBeenCalled();
    expect((await tryRefreshUpstreamTokens(server)).tokens?.refresh_token).toBe(
      "rotated",
    );
  });
  it("does not send credentials after a resource URL change", async () => {
    vi.mocked(repo.findByMcpServerUuid).mockResolvedValue(
      session("alice") as never,
    );
    expect(
      (
        await tryRefreshUpstreamTokens({
          ...server,
          url: "https://changed.example",
        })
      ).status,
    ).toBe("no_session");
    expect(safeOAuthFetch).not.toHaveBeenCalled();
  });
});
