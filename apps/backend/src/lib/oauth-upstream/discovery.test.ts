import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
import { discoverUpstreamOAuth } from "./discovery";

const resource = "https://resource.example/api/v4/mcp";
const issuer = "https://identity.example/tenant";
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
let routes: Record<string, () => Response>;
let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  routes = {
    [resource]: () =>
      new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://resource.example/custom-metadata", scope="mcp api"',
        },
      }),
    "https://resource.example/custom-metadata": () =>
      json({ resource, authorization_servers: [issuer] }),
    "https://identity.example/.well-known/oauth-authorization-server/tenant":
      () => json(metadata),
  };
  fetchFn = vi.fn(
    async (url) =>
      routes[String(url)]?.() ?? new Response(null, { status: 404 }),
  );
});

describe("RFC 9728 / RFC 8414 discovery", () => {
  it("follows a Bearer challenge to a separate issuer with a path, without browser/CORS requests", async () => {
    expect(await discoverUpstreamOAuth(resource, fetchFn)).toEqual({
      metadata,
      resource,
      scope: "mcp api",
    });
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      resource,
      "https://resource.example/custom-metadata",
      "https://identity.example/.well-known/oauth-authorization-server/tenant",
    ]);
    expect(
      fetchFn.mock.calls.every(
        ([, init]) => !new Headers(init?.headers).has("authorization"),
      ),
    ).toBe(true);
  });
  it("uses path-aware protected metadata and OIDC fallback when no challenge is supplied", async () => {
    routes[resource] = () => new Response(null, { status: 401 });
    routes[
      "https://resource.example/.well-known/oauth-protected-resource/api/v4/mcp"
    ] = () =>
      json({
        resource,
        authorization_servers: [issuer],
        scopes_supported: ["mcp"],
      });
    delete routes[
      "https://identity.example/.well-known/oauth-authorization-server/tenant"
    ];
    routes["https://identity.example/tenant/.well-known/openid-configuration"] =
      () => json(metadata);
    expect((await discoverUpstreamOAuth(resource, fetchFn)).scope).toBe("mcp");
  });
  it.each([
    {
      resource: "https://attacker.example/mcp",
      authorization_servers: [issuer],
    },
    { resource, authorization_servers: ["https://127.0.0.1"] },
  ])(
    "rejects mismatched resources and unsafe issuer destinations",
    async (protectedMetadata) => {
      routes["https://resource.example/custom-metadata"] = () =>
        json(protectedMetadata);
      await expect(discoverUpstreamOAuth(resource, fetchFn)).rejects.toThrow();
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    { ...metadata, issuer: "https://wrong.example" },
    { ...metadata, token_endpoint: "https://169.254.169.254/token" },
    { ...metadata, authorization_endpoint: "javascript:alert(1)" },
    { ...metadata, registration_endpoint: "http://insecure.example/register" },
    { ...metadata, code_challenge_methods_supported: ["plain"] },
  ])(
    "rejects unsafe/mismatched AS metadata without fallback",
    async (badMetadata) => {
      routes[
        "https://identity.example/.well-known/oauth-authorization-server/tenant"
      ] = () => json(badMetadata);
      await expect(discoverUpstreamOAuth(resource, fetchFn)).rejects.toThrow();
      expect(fetchFn).toHaveBeenCalledTimes(3);
    },
  );
  it("rejects an unsafe challenge URL before fetching it", async () => {
    routes[resource] = () =>
      new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://127.0.0.1/private"',
        },
      });
    await expect(discoverUpstreamOAuth(resource, fetchFn)).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
