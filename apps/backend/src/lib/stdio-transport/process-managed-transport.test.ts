import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";
vi.mock("cross-spawn", () => ({ default: vi.fn() }));
vi.mock("../../utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import spawn from "cross-spawn";

import { ProcessManagedStdioTransport } from "./process-managed-transport";
afterEach(() => {
  vi.restoreAllMocks();
});
it("concurrent close sends one termination signal and emits close once", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    unref: vi.fn(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockImplementation((_command, _args, options) => {
    options?.signal?.addEventListener("abort", () =>
      child.emit(
        "error",
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
    );
    queueMicrotask(() => child.emit("spawn"));
    return child as never;
  });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  const transport = new ProcessManagedStdioTransport({ command: "fixture" });
  const closed = vi.fn();
  const crashed = vi.fn();
  transport.onclose = closed;
  transport.onprocesscrash = crashed;
  await transport.start();
  await Promise.all([transport.close(), transport.close(), transport.close()]);
  expect(kill).toHaveBeenCalledOnce();
  expect(closed).toHaveBeenCalledOnce();
  expect(crashed).not.toHaveBeenCalled();
});
it("settles initialization when shutdown happens before spawn", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    unref: vi.fn(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockImplementation((_command, _args, options) => {
    options?.signal?.addEventListener("abort", () =>
      child.emit(
        "error",
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
    );
    return child as never;
  });
  vi.spyOn(process, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  const transport = new ProcessManagedStdioTransport({ command: "fixture" });
  const started = expect(transport.start()).rejects.toThrow("aborted");
  await transport.close();
  await started;
});
