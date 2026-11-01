import { createHash } from "node:crypto";

import {
  BeginOAuthRequestSchema,
  ExchangeOAuthTokenRequestSchema,
  UpsertOAuthSessionRequestSchema,
} from "@repo/zod-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/repositories", () => ({
  oauthSessionsRepository: {
    findByMcpServerUuid: vi.fn(),
    upsert: vi.fn(),
    consumeState: vi.fn(),
  },
  mcpServersRepository: { findByUuid: vi.fn() },
}));
vi.mock("../lib/oauth-upstream/discovery", () => ({
  discoverUpstreamOAuth: vi.fn(),
}));
vi.mock("../lib/oauth-upstream/safe-fetch", () => ({
  validateOAuthUrl: vi.fn(),
  safeOAuthFetch: vi.fn(),
  readOAuthJson: (r: Response) => r.json(),
}));

import {
  mcpServersRepository,
  oauthSessionsRepository as repo,
} from "../db/repositories";
import { discoverUpstreamOAuth } from "../lib/oauth-upstream/discovery";
import { safeOAuthFetch } from "../lib/oauth-upstream/safe-fetch";
import { oauthImplementations as oauth } from "./oauth.impl";
import { createOAuthRouter } from "../../../../packages/trpc/src/routers/frontend/oauth";

const uuid = "00000000-0000-4000-8000-000000000001";
const serverUrl = "https://resource.example/api/v4/mcp";
const input = { mcp_server_uuid: uuid };
const client = {
  client_id: "registered",
  client_secret: "SECRET",
  server_url: serverUrl,
  token_endpoint: "https://issuer.example/token",
  redirect_uri: "https://metamcp.example/fe-oauth/callback",
  resource: serverUrl,
};
const session = {
  uuid,
  mcp_server_uuid: uuid,
  user_id: "alice",
  client_information: client,
  tokens: {
    access_token: "ACCESS",
    refresh_token: "REFRESH",
    token_type: "Bearer",
  },
  code_verifier: "PKCE",
  expected_state: "HASH",
  flow_expires_at: new Date(),
  created_at: new Date(),
  updated_at: new Date(),
};
const metadata = {
  issuer: "https://issuer.example",
  authorization_endpoint: "https://issuer.example/authorize",
  token_endpoint: "https://issuer.example/token",
  registration_endpoint: "https://issuer.example/register",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.APP_URL = "https://metamcp.example/";
  vi.mocked(mcpServersRepository.findByUuid).mockResolvedValue({
    uuid,
    name: "server",
    url: serverUrl,
    type: "STREAMABLE_HTTP",
    user_id: null,
  } as never);
  vi.mocked(repo.findByMcpServerUuid).mockResolvedValue(session);
  vi.mocked(repo.upsert).mockResolvedValue(session);
  vi.mocked(discoverUpstreamOAuth).mockResolvedValue({
    metadata,
    resource: serverUrl,
    scope: "mcp",
  });
});

describe("OAuth authorization boundaries", () => {
  const calls = [
    ["get", (user: string) => oauth.get(input, user)],
    [
      "upsert",
      (user: string) =>
        oauth.upsert({ ...input, client_information: client }, user),
    ],
    ["begin", (user: string) => oauth.begin(input, user)],
    [
      "exchange",
      (user: string) =>
        oauth.exchangeToken(
          { ...input, code: "code", state: "s".repeat(43) },
          user,
        ),
    ],
    ["refresh", (user: string) => oauth.refreshToken(input, user)],
  ] as const;
  it.each(calls)(
    "rejects unauthorized %s before any credential read/network activity",
    async (_name, call) => {
      vi.mocked(mcpServersRepository.findByUuid).mockResolvedValue({
        user_id: "alice",
        url: serverUrl,
        type: "STREAMABLE_HTTP",
      } as never);
      await expect(call("bob")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(call("")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(repo.findByMcpServerUuid).not.toHaveBeenCalled();
      expect(repo.consumeState).not.toHaveBeenCalled();
      expect(safeOAuthFetch).not.toHaveBeenCalled();
    },
  );

  it("rejects unauthenticated calls at every tRPC procedure", async () => {
    const caller = createOAuthRouter(oauth).createCaller({});
    for (const promise of [
      caller.get(input),
      caller.upsert({ ...input, client_information: client }),
      caller.begin(input),
      caller.exchangeToken({ ...input, code: "c", state: "s".repeat(43) }),
      caller.refreshToken(input),
    ]) {
      await expect(promise).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("returns status/config only and always reads the caller's public-server session", async () => {
    const result = await createOAuthRouter(oauth)
      .createCaller({ user: { id: "alice" }, session: {} })
      .get(input);
    expect(repo.findByMcpServerUuid).toHaveBeenCalledWith(uuid, "alice");
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|ACCESS|REFRESH|PKCE|HASH/,
    );
    expect(result.success && result.data.connected).toBe(true);
  });

  it("rejects browser token/state/verifier writes and missing callback state", () => {
    for (const field of ["tokens", "expected_state", "code_verifier"])
      expect(
        UpsertOAuthSessionRequestSchema.safeParse({
          ...input,
          client_information: client,
          [field]: "injected",
        }).success,
      ).toBe(false);
    expect(
      ExchangeOAuthTokenRequestSchema.safeParse({ ...input, code: "c" })
        .success,
    ).toBe(false);
    expect(BeginOAuthRequestSchema.parse(input)).toEqual(input);
  });
});

describe("backend authorization flow", () => {
  it("registers generically, stores PKCE/state and returns only an authorization URL", async () => {
    vi.mocked(repo.findByMcpServerUuid).mockResolvedValue(undefined);
    vi.mocked(safeOAuthFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          client_id: "dynamic",
          redirect_uris: ["https://metamcp.example/fe-oauth/callback"],
          token_endpoint_auth_method: "none",
        }),
      ),
    );
    const result = await oauth.begin(input, "alice");
    expect(safeOAuthFetch).toHaveBeenCalledWith(
      metadata.registration_endpoint,
      expect.objectContaining({ method: "POST" }),
    );
    const saved = vi.mocked(repo.upsert).mock.calls[0]![0];
    const url = new URL(result.authorization_url);
    expect(url.origin).toBe("https://issuer.example");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(saved.code_verifier!).digest("base64url"),
    );
    expect(url.searchParams.get("state")).toBe(saved.expected_state);
    expect(url.searchParams.get("resource")).toBe(serverUrl);
    expect(url.searchParams.get("scope")).toBe("mcp");
    expect(saved.user_id).toBe("alice");
    expect(saved.flow_expires_at!.getTime()).toBeGreaterThan(Date.now());
    expect(Object.keys(result)).toEqual(["authorization_url"]);
  });

  it("supports pre-registered clients without DCR and preserves their secret on edits", async () => {
    vi.mocked(repo.findByMcpServerUuid).mockResolvedValue({
      ...session,
      client_information: {
        ...client,
        pre_registered: true,
        authorization_endpoint: metadata.authorization_endpoint,
      },
    });
    await oauth.begin(input, "alice");
    expect(discoverUpstreamOAuth).not.toHaveBeenCalled();
    expect(safeOAuthFetch).not.toHaveBeenCalled();
    await oauth.upsert(
      { ...input, client_information: { client_id: client.client_id } },
      "alice",
    );
    expect(repo.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        user_id: "alice",
        tokens: null,
        client_information: expect.objectContaining({
          client_secret: "SECRET",
        }),
      }),
    );
  });

  it("gives a pre-registration action when DCR is unavailable", async () => {
    vi.mocked(repo.findByMcpServerUuid).mockResolvedValue(undefined);
    vi.mocked(discoverUpstreamOAuth).mockResolvedValue({
      metadata: { ...metadata, registration_endpoint: undefined },
      resource: serverUrl,
      scope: undefined,
    });
    await expect(oauth.begin(input, "alice")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("never exchanges without an atomically claimed state", async () => {
    vi.mocked(repo.consumeState).mockResolvedValue(undefined);
    expect(
      await oauth.exchangeToken(
        { ...input, code: "c", state: "s".repeat(43) },
        "bob",
      ),
    ).toMatchObject({ success: false, error: "invalid_state" });
    expect(repo.consumeState).toHaveBeenCalledWith(uuid, "bob", "s".repeat(43));
    expect(safeOAuthFetch).not.toHaveBeenCalled();
  });

  it("exchanges using pinned flow endpoints and saves tokens for the same caller", async () => {
    vi.mocked(repo.consumeState).mockResolvedValue(session);
    vi.mocked(safeOAuthFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "NEW",
          refresh_token: "NEW_REFRESH",
          token_type: "Bearer",
        }),
      ),
    );
    expect(
      await oauth.exchangeToken(
        { ...input, code: "c", state: "s".repeat(43) },
        "alice",
      ),
    ).toMatchObject({ success: true });
    expect(discoverUpstreamOAuth).not.toHaveBeenCalled();
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "alice",
        tokens: expect.objectContaining({ access_token: "NEW" }),
        code_verifier: null,
      }),
    );
  });

  it("fails closed when the MCP URL changes mid-flow or token exchange fails", async () => {
    vi.mocked(repo.consumeState).mockResolvedValue({
      ...session,
      client_information: { ...client, server_url: "https://other.example" },
    });
    expect(
      await oauth.exchangeToken(
        { ...input, code: "c", state: "s".repeat(43) },
        "alice",
      ),
    ).toMatchObject({ success: false, error: "invalid_session" });
    expect(safeOAuthFetch).not.toHaveBeenCalled();
    vi.mocked(repo.consumeState).mockResolvedValue(session);
    vi.mocked(safeOAuthFetch).mockRejectedValue(
      new Error("internal details SECRET"),
    );
    const result = await oauth.exchangeToken(
      { ...input, code: "c", state: "s".repeat(43) },
      "alice",
    );
    expect(result).toMatchObject({
      success: false,
      error: "token_exchange_failed",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
