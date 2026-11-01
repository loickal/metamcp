import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../../db/repositories", () => ({
  mcpServersRepository: {
    findByUuid: vi.fn(),
    findAllAccessibleToUser: vi.fn(),
  },
}));
vi.mock("spawn-rx", () => ({
  findActualExecutable: (command: string, args: string[]) => ({
    cmd: command === "npx" ? "/usr/bin/npx" : command,
    args,
  }),
}));
import { mcpServersRepository } from "../../db/repositories";
import { resolveStdioServerUuid } from "./stdio-server-identity";
const server = {
  uuid: "kuma",
  type: "STDIO",
  user_id: "alice",
  command: "npx",
  args: ["-y", "fixture-package"],
};
beforeEach(() => {
  vi.mocked(mcpServersRepository.findByUuid).mockResolvedValue(server as never);
  vi.mocked(mcpServersRepository.findAllAccessibleToUser).mockResolvedValue([
    server,
  ] as never);
});
it("matches configured npx with resolved /usr/bin/npx without changing configuration", async () => {
  expect(
    await resolveStdioServerUuid({
      command: "/usr/bin/npx",
      args: server.args,
      userId: "alice",
      serverUuid: "kuma",
    }),
  ).toBe("kuma");
});
it("does not identify another package by its shared npx executable", async () => {
  expect(
    await resolveStdioServerUuid({
      command: "npx",
      args: ["-y", "different-package"],
      userId: "alice",
    }),
  ).toBeNull();
});
it("rejects another user's saved server", async () => {
  await expect(
    resolveStdioServerUuid({
      command: "npx",
      args: server.args,
      userId: "bob",
      serverUuid: "kuma",
    }),
  ).rejects.toThrow(/not found/);
});
it("does not guess when legacy command matching is ambiguous", async () => {
  vi.mocked(mcpServersRepository.findAllAccessibleToUser).mockResolvedValue([
    server,
    { ...server, uuid: "other" },
  ] as never);
  expect(
    await resolveStdioServerUuid({
      command: "npx",
      args: server.args,
      userId: "alice",
    }),
  ).toBeNull();
});
