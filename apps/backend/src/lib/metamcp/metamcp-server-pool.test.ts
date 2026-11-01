import { afterEach, expect, it, vi } from "vitest";
vi.mock("./metamcp-proxy", () => ({ createServer: vi.fn() }));
vi.mock("./mcp-server-pool", () => ({
  mcpServerPool: { getPoolStatus: () => ({}) },
}));
import { createServer } from "./metamcp-proxy";
import { MetaMcpServerPool } from "./metamcp-server-pool";
const pool = new MetaMcpServerPool();
const instance = (id: string) => ({
  internalSessionId: id,
  server: { close: vi.fn(async () => {}) },
  cleanup: vi.fn(async () => {}),
});
afterEach(async () => {
  await Promise.all(
    pool.getActiveSessionIds().map((id) => pool.cleanupSession(id)),
  );
  vi.clearAllMocks();
});
it("creates a session-bound SDK server once, never rebinds namespace idle instances", async () => {
  const fixture = instance("one");
  vi.mocked(createServer).mockResolvedValue(fixture as never);
  await pool.ensureIdleServers(["ns"]);
  expect(createServer).not.toHaveBeenCalled();
  const servers = await Promise.all(
    Array.from({ length: 20 }, () => pool.getServer("one", "ns")),
  );
  expect(createServer).toHaveBeenCalledOnce();
  expect(new Set(servers).size).toBe(1);
  expect(createServer).toHaveBeenCalledWith(
    "ns",
    "one",
    false,
    undefined,
    undefined,
  );
  await Promise.all([pool.cleanupSession("one"), pool.cleanupSession("one")]);
  expect(fixture.cleanup).toHaveBeenCalledOnce();
});
it("rejects reuse across namespaces or authenticated identities", async () => {
  vi.mocked(createServer).mockResolvedValue(instance("one") as never);
  const alice = {
    endpointName: "loic",
    auth: { method: "oauth" as const, oauthUserId: "alice" },
  };
  await pool.getServer("one", "ns", false, undefined, undefined, alice);
  await expect(
    pool.getServer("one", "other", false, undefined, undefined, alice),
  ).rejects.toThrow(/context mismatch/);
  await expect(
    pool.getServer("one", "ns", false, undefined, undefined, {
      ...alice,
      auth: { method: "oauth", oauthUserId: "bob" },
    }),
  ).rejects.toThrow(/context mismatch/);
});
it("cleanup cancels initialization and releases the late result exactly once", async () => {
  let finish!: (value: Awaited<ReturnType<typeof createServer>>) => void;
  vi.mocked(createServer).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = pool.getServer("late", "ns");
  await Promise.resolve();
  const closing = pool.cleanupSession("late");
  const fixture = instance("late");
  finish(fixture as never);
  expect(await pending).toBeUndefined();
  await closing;
  expect(fixture.cleanup).toHaveBeenCalledOnce();
  expect(pool.getPoolStatus().active).toBe(0);
});
