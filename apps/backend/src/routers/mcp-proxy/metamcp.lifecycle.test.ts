import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const { cleanup, create } = vi.hoisted(() => ({
  cleanup: vi.fn(async () => {}),
  create: vi.fn(),
}));
vi.mock("../../middleware/better-auth-mcp.middleware", () => ({
  betterAuthMcpMiddleware: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!req.get("x-test-user")) {
      res.status(401).end();
      return;
    }
    Object.assign(req, { user: { id: req.get("x-test-user") } });
    next();
  },
}));
vi.mock("../../lib/metamcp/index", () => ({ createServer: create }));
vi.mock("../../lib/metamcp/mcp-server-pool", () => ({
  mcpServerPool: { cleanupSession: vi.fn(async () => {}) },
}));
vi.mock("../../utils/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../lib/config.service", () => ({
  configService: { getSessionLifetime: async () => 60_000 },
}));
vi.mock("../../db/repositories/namespaces.repo", () => ({
  namespacesRepository: { findByUuid: async () => ({ user_id: null }) },
}));

import metamcpRouter from "./metamcp";

let http: HttpServer;
let url: string;
beforeAll(async () => {
  create.mockImplementation(async () => {
    const server = new Server(
      { name: "fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "fixture_tool", inputSchema: { type: "object" } }],
    }));
    return {
      server,
      cleanup: async () => {
        await cleanup();
        await server.close();
      },
    };
  });
  const app = express();
  // Match production: the SDK parses MCP request bodies itself.
  app.use("/mcp-proxy/metamcp", metamcpRouter);
  await new Promise<void>((resolve) => {
    http = app.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp-proxy/metamcp/61c6e5e8-517f-4bfb-b4e9-51a39d14bd01/mcp`;
});
afterAll(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

const post = (body: unknown, session?: string) =>
  fetch(url, {
    method: "POST",
    headers: {
      "x-test-user": "alice",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session && { "Mcp-Session-Id": session }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });

it("keeps the Inspector MCP session alive after the initialization HTTP response finishes", async () => {
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "regression", version: "1" },
    },
  });
  expect(init.status).toBe(200);
  const session = init.headers.get("mcp-session-id");
  expect(session).toBeTruthy();
  await init.text();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const listed = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    session ?? undefined,
  );
  expect(listed.status).toBe(200);
  expect(await listed.text()).toContain("fixture_tool");
  expect(cleanup).not.toHaveBeenCalled();
  await fetch(url, {
    method: "DELETE",
    headers: { "x-test-user": "alice", "Mcp-Session-Id": session ?? "" },
  });
});

async function initialize() {
  const response = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "regression", version: "1" },
    },
  });
  await response.text();
  expect(response.status).toBe(200);
  const id = response.headers.get("mcp-session-id");
  if (!id) throw new Error("Initialization did not issue a session ID");
  return id;
}
const terminate = (id: string, user = "alice") =>
  fetch(url, {
    method: "DELETE",
    headers: { "x-test-user": user, "Mcp-Session-Id": id },
  });
it("reuses one session for concurrent requests without duplicate initialization", async () => {
  const created = create.mock.calls.length;
  const cleaned = cleanup.mock.calls.length;
  const id = await initialize();
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      post({ jsonrpc: "2.0", id: 10 + i, method: "tools/list" }, id),
    ),
  );
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fixture_tool");
  }
  expect(create.mock.calls.length - created).toBe(1);
  expect(cleanup.mock.calls.length).toBe(cleaned);
  await terminate(id);
});
it("concurrent DELETE cleans only its target once; missing sessions can reinitialize", async () => {
  const a = await initialize();
  const b = await initialize();
  const cleaned = cleanup.mock.calls.length;
  const deleted = await Promise.all([terminate(a), terminate(a)]);
  expect(deleted.map((response) => response.status)).toContain(200);
  expect(cleanup.mock.calls.length - cleaned).toBe(1);
  expect(
    (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, a)).status,
  ).toBe(404);
  const existing = await post(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    b,
  );
  expect(existing.status).toBe(200);
  await existing.text();
  const fresh = await initialize();
  expect(fresh).not.toBe(a);
  await terminate(b);
  await terminate(fresh);
});
it("binds transport reuse and DELETE to the authenticated identity AND namespace", async () => {
  const id = await initialize();
  const bob = await terminate(id, "bob");
  expect(bob.status).toBe(404);
  const other = await fetch(
    url.replace("61c6e5e8-517f-4bfb-b4e9-51a39d14bd01", "other-namespace"),
    {
      method: "DELETE",
      headers: { "x-test-user": "alice", "Mcp-Session-Id": id },
    },
  );
  expect(other.status).toBe(404);
  const unauthenticated = await fetch(url, {
    method: "DELETE",
    headers: { "Mcp-Session-Id": id },
  });
  expect(unauthenticated.status).toBe(401);
  const response = await post(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    id,
  );
  expect(response.status).toBe(200);
  await response.text();
  await terminate(id);
});
it("an optional Streamable HTTP SSE stream disconnect does not end the session", async () => {
  const id = await initialize();
  const abort = new AbortController();
  const stream = await fetch(url, {
    headers: {
      "x-test-user": "alice",
      "Mcp-Session-Id": id,
      Accept: "text/event-stream",
    },
    signal: abort.signal,
  });
  expect(stream.status).toBe(200);
  abort.abort();
  const response = await post(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    id,
  );
  expect(response.status).toBe(200);
  await response.text();
  await terminate(id);
});
it("legacy SSE still initializes and cleans up on stream disconnect", async () => {
  const cleaned = cleanup.mock.calls.length;
  const client = new Client({ name: "legacy", version: "1" });
  const transport = new SSEClientTransport(
    new URL(url.replace(/mcp$/, "sse")),
    {
      requestInit: { headers: { "x-test-user": "alice" } },
      eventSourceInit: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...init?.headers, "x-test-user": "alice" },
          }),
      },
    },
  );
  await client.connect(transport);
  expect((await client.listTools()).tools[0]?.name).toBe("fixture_tool");
  await client.close();
  await vi.waitFor(() => expect(cleanup.mock.calls.length - cleaned).toBe(1));
});
it("repeated real SDK Inspector reconnects release every session", async () => {
  const cleaned = cleanup.mock.calls.length;
  const created = create.mock.calls.length;
  for (let i = 0; i < 15; i++) {
    const client = new Client({ name: "inspector", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { "x-test-user": "alice" } },
    });
    await client.connect(transport);
    await client.listTools();
    await transport.terminateSession();
    await client.close();
  }
  expect(create.mock.calls.length - created).toBe(15);
  expect(cleanup.mock.calls.length - cleaned).toBe(15);
});
