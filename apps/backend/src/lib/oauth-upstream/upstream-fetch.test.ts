import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/repositories", () => ({
  oauthSessionsRepository: { findByMcpServerUuid: vi.fn() },
}));
vi.mock("./safe-fetch", () => ({ safeOAuthFetch: vi.fn() }));
vi.mock("./refresh-on-401", () => ({ tryRefreshUpstreamTokens: vi.fn() }));
import { oauthSessionsRepository as repo } from "../../db/repositories";
import { tryRefreshUpstreamTokens } from "./refresh-on-401";
import { safeOAuthFetch } from "./safe-fetch";
import { createUpstreamFetch } from "./upstream-fetch";

const server = {
  uuid: "shared-server",
  name: "test",
  url: "https://resource.example/mcp",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
describe("upstream token attachment", () => {
  it("attaches each user's access token on the backend, including on a public config", async () => {
    vi.mocked(repo.findByMcpServerUuid).mockImplementation(
      async (_server, user) =>
        ({
          client_information: { server_url: server.url },
          tokens: { access_token: `${user}-token` },
        }) as never,
    );
    const authorizations: string[] = [];
    vi.mocked(safeOAuthFetch).mockImplementation(async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization")!);
      return new Response("ok");
    });
    await Promise.all([
      createUpstreamFetch(server, "alice")(server.url),
      createUpstreamFetch(server, "bob")(server.url),
    ]);
    expect(authorizations.sort()).toEqual([
      "Bearer alice-token",
      "Bearer bob-token",
    ]);
  });
  it("does not look up personal credentials for anonymous/non-OAuth connections", async () => {
    const plainFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", plainFetch);
    const response = await createUpstreamFetch(server)(server.url, {
      headers: { "X-Existing": "preserved" },
    });
    expect(await response.text()).toBe("ok");
    expect(repo.findByMcpServerUuid).not.toHaveBeenCalled();
    expect(safeOAuthFetch).not.toHaveBeenCalled();
    expect(
      new Headers(plainFetch.mock.calls[0]?.[1]?.headers).get("X-Existing"),
    ).toBe("preserved");
  });
  it("preserves 401/WWW-Authenticate after at most one refresh attempt", async () => {
    vi.mocked(repo.findByMcpServerUuid).mockResolvedValue({
      client_information: { server_url: server.url },
      tokens: { access_token: "old", refresh_token: "refresh" },
    } as never);
    vi.mocked(safeOAuthFetch).mockImplementation(
      async () =>
        new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://resource.example/meta"',
          },
        }),
    );
    vi.mocked(tryRefreshUpstreamTokens).mockResolvedValue({
      status: "refreshed",
      tokens: { access_token: "new", token_type: "Bearer" },
    });
    const response = await createUpstreamFetch(server, "alice")(server.url);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata",
    );
    expect(safeOAuthFetch).toHaveBeenCalledTimes(2);
    expect(tryRefreshUpstreamTokens).toHaveBeenCalledWith({
      ...server,
      oauth_user_id: "alice",
    });
  });
  it("never sends credentials to a cross-origin SSE endpoint", async () => {
    await expect(
      createUpstreamFetch(server, "alice")("https://evil.example/steal"),
    ).rejects.toThrow("Cross-origin");
    expect(repo.findByMcpServerUuid).not.toHaveBeenCalled();
  });
});
