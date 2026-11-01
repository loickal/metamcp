import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../lib/oauth-upstream/access", () => ({
  requireOAuthServer: vi.fn(),
}));
vi.mock("../../lib/oauth-upstream/upstream-fetch", () => ({
  createUpstreamFetch: vi.fn(),
}));
import { requireOAuthServer } from "../../lib/oauth-upstream/access";
import { createUpstreamFetch } from "../../lib/oauth-upstream/upstream-fetch";
import { upstreamHttpRouter } from "./upstream-http";

let http: Server;
let url: string;
const upstream = vi.fn<typeof fetch>();
const uuid = "00000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    if (req.get("x-test-user"))
      Object.assign(req, { user: { id: req.get("x-test-user") } });
    next();
  });
  app.use(upstreamHttpRouter);
  await new Promise<void>((resolve) => {
    http = app.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp?mcpServerUuid=${uuid}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireOAuthServer).mockResolvedValue({
    uuid,
    name: "test",
    url: "https://upstream.example/mcp",
    type: "STREAMABLE_HTTP",
  } as never);
  vi.mocked(createUpstreamFetch).mockReturnValue(upstream);
});
const post = (user = "alice", session?: string) =>
  fetch(url, {
    method: "POST",
    headers: {
      "x-test-user": user,
      "content-type": "application/json",
      ...(session && { "mcp-session-id": session }),
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
  });

describe("HTTP MCP proxy", () => {
  it("preserves an initialize-time 401 and its Bearer challenge", async () => {
    upstream.mockResolvedValue(
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://upstream.example/meta"',
          "Content-Type": "application/json",
        },
      }),
    );
    const result = await post();
    expect(result.status).toBe(401);
    expect(result.headers.get("www-authenticate")).toContain(
      "resource_metadata",
    );
    expect(createUpstreamFetch).toHaveBeenCalledWith(
      expect.objectContaining({ uuid }),
      "alice",
      "https://upstream.example/mcp",
    );
    expect(await result.json()).toMatchObject({ error: "unauthorized" });
  });
  it("keeps upstream session IDs private and rejects cross-user resumption/deletion", async () => {
    upstream.mockImplementation(
      async () =>
        new Response("{}", {
          headers: { "mcp-session-id": "UPSTREAM_PRIVATE_SESSION" },
        }),
    );
    const connected = await post();
    await connected.text();
    const id = connected.headers.get("mcp-session-id");
    if (!id) throw new Error("Missing session ID");
    expect(id).toBeTruthy();
    expect(id).not.toBe("UPSTREAM_PRIVATE_SESSION");
    expect((await post("bob", id)).status).toBe(404);
    expect(
      (
        await fetch(url, {
          method: "DELETE",
          headers: { "x-test-user": "bob", "mcp-session-id": id },
        })
      ).status,
    ).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);
    const resumed = await post("alice", id);
    await resumed.text();
    expect(
      new Headers(upstream.mock.calls[1]?.[1]?.headers).get("mcp-session-id"),
    ).toBe("UPSTREAM_PRIVATE_SESSION");
  });
  it("preserves non-OAuth streaming responses and rejects anonymous proxy requests", async () => {
    upstream.mockResolvedValue(
      new Response("event: message\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: message");
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
  });
});
