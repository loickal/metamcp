import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./config.service", () => ({
  configService: { getSessionLifetime: vi.fn(async () => 1000) },
}));
vi.mock("../utils/logger", () => ({ default: { info: vi.fn() } }));
import { SessionLifetimeManagerImpl } from "./session-lifetime-manager";
let manager: SessionLifetimeManagerImpl<object>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  manager = new SessionLifetimeManagerImpl("test", 2);
});
afterEach(() => {
  manager.stopCleanupTimer();
  for (const id of manager.getSessionIds()) manager.removeSession(id);
  vi.useRealTimers();
});
it("publishes only ACTIVE sessions and bounds initializing reservations", () => {
  manager.addSession("a", {}, "INITIALIZING");
  expect(manager.getSession("a")).toBeUndefined();
  manager.activate("a");
  expect(manager.getSession("a")).toEqual({});
  manager.addSession("b", {}, "INITIALIZING");
  expect(() => manager.addSession("c", {})).toThrow(/capacity/);
});
it("expires by last activity, including timestamp zero, not creation time", async () => {
  const cleanup = vi.fn(async () => {});
  manager.addSession("active", {});
  manager.addSession("idle", {});
  vi.setSystemTime(900);
  manager.getSession("active");
  vi.setSystemTime(1100);
  await manager.cleanupExpiredSessions(cleanup);
  expect(cleanup.mock.calls).toHaveLength(1);
  expect(manager.getSessionIds()).toEqual(["active"]);
  vi.setSystemTime(2001);
  await manager.cleanupExpiredSessions(cleanup);
  expect(manager.getSessionCount()).toBe(0);
});
it("protects in-flight work and resets activity on completion", async () => {
  manager.addSession("busy", {});
  let finish!: () => void;
  const operation = manager.run(
    "busy",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  vi.setSystemTime(5000);
  const cleanup = vi.fn(async () => {});
  await manager.cleanupExpiredSessions(cleanup);
  expect(cleanup).not.toHaveBeenCalled();
  finish();
  await operation;
  await manager.cleanupExpiredSessions(cleanup);
  expect(cleanup).not.toHaveBeenCalled();
});
it("concurrent DELETE, transport close and sweeps clean exactly once after draining", async () => {
  manager.addSession("busy", {});
  let finish!: () => void;
  const operation = manager.run(
    "busy",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const cleanup = vi.fn(async () => {
    await manager.close("absent", cleanup);
  });
  const first = manager.close("busy", cleanup);
  const second = manager.close("busy", cleanup, "transport_closed");
  expect(first).toBe(second);
  expect(manager.getState("busy")).toBe("CLOSING");
  await expect(manager.run("busy", async () => {})).rejects.toThrow(
    /not found/,
  );
  await Promise.resolve();
  expect(cleanup).not.toHaveBeenCalled();
  finish();
  await operation;
  await Promise.all([first, second]);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(manager.getSessionCount()).toBe(0);
});
it("restarting the timer replaces it and overlapping sweeps share one cleanup", async () => {
  const cleanup = vi.fn(async () => {});
  manager.addSession("a", {});
  manager.startCleanupTimer(cleanup, 100);
  manager.startCleanupTimer(cleanup, 100);
  expect(vi.getTimerCount()).toBe(1);
  vi.setSystemTime(2000);
  await Promise.all([
    manager.cleanupExpiredSessions(cleanup),
    manager.cleanupExpiredSessions(cleanup),
  ]);
  expect(cleanup).toHaveBeenCalledOnce();
});
