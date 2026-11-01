import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ status: "ACTIVE", fail: false }));
vi.mock("../../../db/index", () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: async () => {
          if (fixture.fail) throw new Error("fixture DB unavailable");
          return "status" in fields
            ? [{ status: fixture.status }]
            : [{ uuid: "server", name: "Home Assistant" }];
        },
      };
      return query;
    },
  },
}));
vi.mock("../../../utils/logger", () => ({ default: { error: vi.fn() } }));
import {
  createFilterCallToolMiddleware,
  createFilterListToolsMiddleware,
} from "./filter-tools.functional";
const context = {
  namespaceUuid: "ns",
  sessionId: "session",
  endpointName: "loic",
};
const tool = {
  name: "HomeAssistant__toggle",
  inputSchema: { type: "object" as const },
};
beforeEach(() => {
  fixture.status = "ACTIVE";
  fixture.fail = false;
});
it("checks current disabled status for sanitized server names on discovery and calls", async () => {
  const listed = createFilterListToolsMiddleware({ cacheEnabled: false })(
    async () => ({ tools: [tool] }),
  );
  const execute = vi.fn(async () => ({ content: [] }));
  const call = createFilterCallToolMiddleware({ cacheEnabled: false })(execute);
  expect((await listed({ method: "tools/list" }, context)).tools).toHaveLength(
    1,
  );
  fixture.status = "INACTIVE";
  expect((await listed({ method: "tools/list" }, context)).tools).toHaveLength(
    0,
  );
  expect(
    (await call({ method: "tools/call", params: { name: tool.name } }, context))
      .isError,
  ).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});
it("fails discovery when permission lookup fails instead of exposing disabled tools", async () => {
  fixture.fail = true;
  const listed = createFilterListToolsMiddleware({ cacheEnabled: false })(
    async () => ({ tools: [tool] }),
  );
  await expect(listed({ method: "tools/list" }, context)).rejects.toThrow(
    /unavailable/,
  );
});
