import type { ServerParameters } from "@repo/zod-types";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ connectMetaMcpClient: vi.fn() }));
vi.mock("../config.service", () => ({
  configService: { getSessionLifetime: vi.fn(async () => 3600) },
}));
vi.mock("./server-error-tracker", () => ({ serverErrorTracker: {} }));
vi.mock("./log-store", () => ({ metamcpLogStore: { addLog: vi.fn() } }));
vi.mock("../../utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ConnectedClient, connectMetaMcpClient } from "./client";
import { mcpServerPool } from "./mcp-server-pool";

const params = {
  uuid: "shared-server",
  name: "test",
  type: "STREAMABLE_HTTP",
  url: "https://resource.example/mcp",
  description: "",
  created_at: "",
  status: "active",
  stderr: "ignore",
} satisfies ServerParameters;
beforeEach(async () => {
  await mcpServerPool.cleanupAll();
  vi.clearAllMocks();
  vi.mocked(connectMetaMcpClient).mockImplementation(
    async () =>
      ({
        client: {},
        cleanup: vi.fn(async () => {}),
      }) as unknown as ConnectedClient,
  );
});
afterAll(() => mcpServerPool.cleanupAll());

describe("personal OAuth pool isolation", () => {
  it("creates separate users' connections and destroys them instead of recycling", async () => {
    const alice = await mcpServerPool.getSession("alice-session", params.uuid, {
      ...params,
      oauth_user_id: "alice",
    });
    const bob = await mcpServerPool.getSession("bob-session", params.uuid, {
      ...params,
      oauth_user_id: "bob",
    });
    expect(alice).not.toBe(bob);
    expect(mcpServerPool.getPoolStatus().idle).toBe(0);
    await mcpServerPool.cleanupSession("alice-session");
    expect(alice?.cleanup).toHaveBeenCalledOnce();
    expect(mcpServerPool.getPoolStatus().idle).toBe(0);
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(2);
  });
  it("never lends another user's connection when the server cap is reached", async () => {
    for (let i = 0; i < 5; i++)
      await mcpServerPool.getSession(`session-${i}`, params.uuid, {
        ...params,
        oauth_user_id: `user-${i}`,
      });
    expect(
      await mcpServerPool.getSession("sixth", params.uuid, {
        ...params,
        oauth_user_id: "sixth",
      }),
    ).toBeUndefined();
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(5);
    const anonymous = await mcpServerPool.getSession(
      "anonymous",
      params.uuid,
      params,
    );
    expect(anonymous?.oauthUserId).toBeUndefined();
    expect(connectMetaMcpClient).toHaveBeenLastCalledWith(
      params,
      expect.any(Function),
    );
  });
});
