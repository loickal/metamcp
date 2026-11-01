import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServerParameters } from "@repo/zod-types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ connectMetaMcpClient: vi.fn() }));
vi.mock("./fetch-metamcp", () => ({ getMcpServers: vi.fn() }));
vi.mock("../config.service", () => ({
  configService: {
    getSessionLifetime: async () => 60_000,
    getMcpTimeout: async () => 1000,
    getMcpResetTimeoutOnProgress: async () => false,
    getMcpMaxTotalTimeout: async () => 1000,
  },
}));
vi.mock("../../db/repositories/namespaces.repo", () => ({
  namespacesRepository: {
    findByUuid: async () => ({ description: "fixture" }),
  },
}));
vi.mock("../../trpc/tools.impl", () => ({
  toolsImplementations: { sync: vi.fn() },
}));
vi.mock("../admin-mcp/tools-registry", () => ({
  isExposedAdminToolName: () => false,
  getAdminToolsForMcp: () => [],
}));
vi.mock("./metamcp-middleware/audit-requests.functional", () => ({
  createAuditCallToolMiddleware: () => (handler: unknown) => handler,
}));
vi.mock("./metamcp-middleware/filter-tools.functional", () => ({
  createFilterCallToolMiddleware: () => (handler: unknown) => handler,
  createFilterListToolsMiddleware: () => (handler: unknown) => handler,
}));
vi.mock("./metamcp-middleware/tool-overrides.functional", () => ({
  createToolOverridesCallToolMiddleware: () => (handler: unknown) => handler,
  createToolOverridesListToolsMiddleware: () => (handler: unknown) => handler,
  mapOverrideNameToOriginal: async (name: string) => name,
}));
vi.mock("./metamcp-middleware/tool-identity", () => ({
  resolveToolIdentity: vi.fn(),
}));
vi.mock("./server-error-tracker", () => ({ serverErrorTracker: {} }));
vi.mock("./log-store", () => ({ metamcpLogStore: { addLog: vi.fn() } }));
vi.mock("../../utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { type ConnectedClient, connectMetaMcpClient } from "./client";
import { getMcpServers } from "./fetch-metamcp";
import { mcpServerPool } from "./mcp-server-pool";
import { createServer } from "./metamcp-proxy";

const parameters = (uuid: string, name: string): ServerParameters => ({
  uuid,
  name,
  type: "STREAMABLE_HTTP",
  url: "https://example.test/mcp",
  description: "",
  created_at: "",
  status: "active",
  stderr: "ignore",
  oauth_user_id: "alice",
});
const coolify = parameters("coolify", "Coolify");
const kuma = parameters("kuma", "UptimeKuma");
const toolName = (uuid: string) =>
  uuid === "coolify" ? "list_servers" : "getMonitorSummary";
let dead = new Set<ConnectedClient>();
let unavailable = new Set<string>();
let ambiguousCall = false;
let connections: ConnectedClient[] = [];
let calls: string[] = [];
let client: Client;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  await mcpServerPool.cleanupAll();
  vi.clearAllMocks();
  dead = new Set();
  unavailable = new Set();
  connections = [];
  calls = [];
  ambiguousCall = false;
  vi.mocked(getMcpServers).mockResolvedValue({ coolify, kuma });
  vi.mocked(connectMetaMcpClient).mockImplementation(async (params) => {
    if (unavailable.has(params.uuid)) return undefined;
    const connection = {
      cleanup: vi.fn(async () => {
        dead.add(connection);
      }),
      client: {
        getServerVersion: () => ({ name: params.name }),
        getServerCapabilities: () => ({
          tools: {},
          prompts: {},
          resources: {},
        }),
        request: vi.fn(
          async (request: {
            method: string;
            params?: { name?: string; uri?: string };
          }) => {
            if (dead.has(connection) || unavailable.has(params.uuid))
              throw new Error(
                "Error POSTing to endpoint (HTTP 404): Session not found",
              );
            if (request.method === "tools/list")
              return {
                tools: [
                  {
                    name: toolName(params.uuid),
                    inputSchema: { type: "object" },
                  },
                ],
              };
            if (request.method === "prompts/list")
              return { prompts: [{ name: "summary" }] };
            if (request.method === "resources/list")
              return {
                resources: [
                  { uri: `fixture://${params.uuid}`, name: "status" },
                ],
              };
            if (request.method === "prompts/get")
              return {
                messages: [
                  {
                    role: "user",
                    content: { type: "text", text: "fixture prompt" },
                  },
                ],
              };
            if (request.method === "resources/read")
              return {
                contents: [
                  { uri: request.params?.uri, text: "fixture resource" },
                ],
              };
            calls.push(request.params?.name ?? "");
            if (ambiguousCall) throw new Error("Not connected");
            return { content: [{ type: "text", text: "fixture result" }] };
          },
        ),
      },
    } as unknown as ConnectedClient;
    connections.push(connection);
    return connection;
  });
  const instance = await createServer(
    "namespace",
    "downstream",
    false,
    undefined,
    { endpointName: "loic", auth: { method: "oauth", oauthUserId: "alice" } },
  );
  cleanup = instance.cleanup;
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "fixture", version: "1" });
  await instance.server.connect(b);
  await client.connect(a);
});
afterEach(async () => {
  await client.close();
  await cleanup();
  await mcpServerPool.cleanupAll();
});
it("recovers lost upstream sessions and preserves the complete stable tools/list", async () => {
  const first = await client.listTools();
  expect(first.tools.map((tool) => tool.name).sort()).toEqual([
    "Coolify__list_servers",
    "UptimeKuma__getMonitorSummary",
  ]);
  connections.forEach((connection) => dead.add(connection));
  const after = await client.listTools();
  expect(after.tools).toEqual(first.tools);
  expect(connections).toHaveLength(4);
});
it("an unavailable upstream fails discovery explicitly and its enabled tools return after recovery", async () => {
  await client.listTools();
  unavailable.add("kuma");
  await expect(client.listTools()).rejects.toThrow(/no complete tool catalog/);
  unavailable.clear();
  expect((await client.listTools()).tools).toHaveLength(2);
});
it("a previously advertised tool remains callable after reconnect, without reconnecting unrelated servers", async () => {
  await client.listTools();
  const first = connections[0];
  expect(first).toBeDefined();
  if (first) dead.add(first);
  const result = await client.callTool({ name: "Coolify__list_servers" });
  expect(result.content).toEqual([{ type: "text", text: "fixture result" }]);
  expect(connections).toHaveLength(3);
  expect(calls).toEqual(["list_servers"]);
  expect(connections[1]?.cleanup).not.toHaveBeenCalled();
});
it("never retries a tool whose execution may already have happened", async () => {
  await client.listTools();
  ambiguousCall = true;
  await expect(
    client.callTool({ name: "Coolify__list_servers" }),
  ).rejects.toThrow(/execution may have occurred/);
  expect(calls).toEqual(["list_servers"]);
});
it("does not route a cached advertised tool after its server is disabled", async () => {
  await client.listTools();
  vi.mocked(getMcpServers).mockResolvedValue({ kuma });
  await expect(
    client.callTool({ name: "Coolify__list_servers" }),
  ).rejects.toThrow(/Unknown/);
  expect(calls).toEqual([]);
});
it("concurrent discovery recovery creates one replacement per failed upstream", async () => {
  await client.listTools();
  connections.forEach((connection) => dead.add(connection));
  const results = await Promise.all(
    Array.from({ length: 10 }, () => client.listTools()),
  );
  expect(results.every((result) => result.tools.length === 2)).toBe(true);
  expect(connections).toHaveLength(4);
});
it("advertised UptimeKuma tools execute across twenty live downstream sessions and an older session can reconnect", async () => {
  const opened: Array<{ sdk: Client; cleanup: () => Promise<void> }> = [];
  try {
    await client.listTools();
    for (let i = 0; i < 20; i++) {
      const instance = await createServer(
        "namespace",
        `chatgpt-call-${i}`,
        false,
        undefined,
        {
          endpointName: "loic",
          auth: { method: "oauth", oauthUserId: "alice" },
        },
      );
      const [a, b] = InMemoryTransport.createLinkedPair();
      const sdk = new Client({ name: "chatgpt-fixture", version: "1" });
      await instance.server.connect(b);
      await sdk.connect(a);
      opened.push({ sdk, cleanup: instance.cleanup });
      expect(
        (await sdk.callTool({ name: "UptimeKuma__getMonitorSummary" })).content,
      ).toEqual([{ type: "text", text: "fixture result" }]);
      expect(mcpServerPool.getPoolStatus().active).toBeLessThanOrEqual(6); // five Kuma slots plus the discovery's Coolify connection
    }
    expect(
      (await client.callTool({ name: "UptimeKuma__getMonitorSummary" }))
        .content,
    ).toEqual([{ type: "text", text: "fixture result" }]);
    expect(calls).toHaveLength(21);
  } finally {
    for (const connection of opened) {
      await connection.sdk.close();
      await connection.cleanup();
    }
  }
});

it("advertised prompts and resources reacquire clients after pool pressure", async () => {
  await client.listPrompts();
  await client.listResources();
  const old = mcpServerPool.getSessionConnections("downstream")?.coolify;
  for (let i = 0; i < 6; i++)
    await mcpServerPool.withSessionActivity(
      `metadata-pressure-${i}`,
      async () => {
        await mcpServerPool.getSession(
          `metadata-pressure-${i}`,
          "coolify",
          coolify,
          "namespace",
        );
      },
    );
  expect(old?.cleanup).toHaveBeenCalledOnce();
  expect(
    (await client.getPrompt({ name: "Coolify__summary" })).messages[0]?.content,
  ).toEqual({ type: "text", text: "fixture prompt" });
  expect(
    (await client.readResource({ uri: "fixture://coolify" })).contents[0],
  ).toEqual({ uri: "fixture://coolify", text: "fixture resource" });
});
