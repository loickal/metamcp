import type { ServerParameters } from "@repo/zod-types";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ connectMetaMcpClient: vi.fn() }));
vi.mock("../config.service", () => ({
  configService: { getSessionLifetime: vi.fn(async () => 3600) },
}));
vi.mock("./server-error-tracker", () => ({
  serverErrorTracker: { recordServerCrash: vi.fn(async () => {}) },
}));
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
  it("reclaims an unused slot without lending another user's credentials", async () => {
    const prior: ConnectedClient[] = [];
    for (let i = 0; i < 5; i++) {
      const connected = await mcpServerPool.getSession(
        `session-${i}`,
        params.uuid,
        { ...params, oauth_user_id: `user-${i}` },
      );
      if (connected) prior.push(connected);
    }
    const sixth = await mcpServerPool.getSession("sixth", params.uuid, {
      ...params,
      oauth_user_id: "sixth",
    });
    expect(sixth?.oauthUserId).toBe("sixth");
    expect(prior).not.toContain(sixth);
    expect(prior[0]?.cleanup).toHaveBeenCalledOnce();
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(6);
    const anonymous = await mcpServerPool.getSession(
      "anonymous",
      params.uuid,
      params,
    );
    expect(anonymous).toBeDefined();
    expect(anonymous?.oauthUserId).toBeUndefined();
    expect(prior).not.toContain(anonymous);
    expect(mcpServerPool.getPoolStatus().active).toBe(5);
  });
});

it("deduplicates concurrent initialization for one upstream and session", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      mcpServerPool.getSession("same", params.uuid, {
        ...params,
        oauth_user_id: "alice",
      }),
    ),
  );
  expect(new Set(results).size).toBe(1);
  expect(connectMetaMcpClient).toHaveBeenCalledOnce();
});
it("invalidates only the failed connection and ignores stale recovery attempts", async () => {
  const personal = { ...params, oauth_user_id: "alice" };
  const old = await mcpServerPool.getSession("one", params.uuid, personal);
  const other = await mcpServerPool.getSession("two", params.uuid, {
    ...params,
    oauth_user_id: "bob",
  });
  await mcpServerPool.invalidateServerConnection("one", params.uuid, old);
  const fresh = await mcpServerPool.getSession("one", params.uuid, personal);
  await mcpServerPool.invalidateServerConnection("one", params.uuid, old);
  expect(old?.cleanup).toHaveBeenCalledOnce();
  expect(fresh?.cleanup).not.toHaveBeenCalled();
  expect(other?.cleanup).not.toHaveBeenCalled();
});
it("cancels pending creation during cleanup without resurrecting or leaking a client", async () => {
  let finish!: (client: ConnectedClient) => void;
  vi.mocked(connectMetaMcpClient).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = mcpServerPool.getSession("pending", params.uuid, {
    ...params,
    oauth_user_id: "alice",
  });
  await Promise.resolve();
  const closing = mcpServerPool.cleanupSession("pending");
  const client = {
    client: {},
    cleanup: vi.fn(async () => {}),
  } as unknown as ConnectedClient;
  finish(client);
  expect(await pending).toBeUndefined();
  await closing;
  expect(client.cleanup).toHaveBeenCalledOnce();
  expect(mcpServerPool.getPoolStatus().active).toBe(0);
});
it("never recycles forwarded credentials and stays bounded through repeated reconnects", async () => {
  const forwarded = {
    ...params,
    forward_headers: { Authorization: "Authorization" },
    headers: { Authorization: "test-only" },
  };
  for (let i = 0; i < 30; i++) {
    const client = await mcpServerPool.getSession(
      `reconnect-${i}`,
      params.uuid,
      forwarded,
    );
    await Promise.all([
      mcpServerPool.cleanupSession(`reconnect-${i}`),
      mcpServerPool.cleanupSession(`reconnect-${i}`),
    ]);
    expect(client?.cleanup).toHaveBeenCalledOnce();
  }
  expect(mcpServerPool.getPoolStatus().idle).toBe(0);
  expect(mcpServerPool.getPoolStatus().active).toBe(0);
});
it("replaces connections when upstream configuration changes", async () => {
  const personal = { ...params, oauth_user_id: "alice" };
  const old = await mcpServerPool.getSession(
    "configuration",
    params.uuid,
    personal,
  );
  const fresh = await mcpServerPool.getSession("configuration", params.uuid, {
    ...personal,
    url: "https://changed.example/mcp",
  });
  expect(fresh).not.toBe(old);
  expect(old?.cleanup).toHaveBeenCalledOnce();
});
it("pending initialization cannot be adopted by another identity", async () => {
  const pending = mcpServerPool.getSession("binding", params.uuid, {
    ...params,
    oauth_user_id: "alice",
  });
  await expect(
    mcpServerPool.getSession("binding", params.uuid, {
      ...params,
      oauth_user_id: "bob",
    }),
  ).rejects.toThrow(/identity mismatch/);
  await pending;
});
it("a process crash closes only that connection, not another user's process", async () => {
  const alice = await mcpServerPool.getSession("alice-crash", params.uuid, {
    ...params,
    oauth_user_id: "alice",
  });
  const bob = await mcpServerPool.getSession("bob-live", params.uuid, {
    ...params,
    oauth_user_id: "bob",
  });
  const crash = vi.mocked(connectMetaMcpClient).mock.calls[0]?.[1];
  expect(crash).toBeDefined();
  crash?.(1, null);
  await vi.waitFor(() => expect(alice?.cleanup).toHaveBeenCalledOnce());
  expect(bob?.cleanup).not.toHaveBeenCalled();
});

it("diagnostic status updates do not recreate a healthy connection", async () => {
  const personal = { ...params, oauth_user_id: "alice" };
  const first = await mcpServerPool.getSession("stable", params.uuid, personal);
  const unchanged = await mcpServerPool.getSession("stable", params.uuid, {
    ...personal,
    error_status: "none",
    description: "changed metadata",
  });
  expect(unchanged).toBe(first);
  expect(connectMetaMcpClient).toHaveBeenCalledOnce();
});
it("a closing idle connection cannot be borrowed while configuration invalidation awaits cleanup", async () => {
  const old = await mcpServerPool.getSession(
    "idle-source",
    params.uuid,
    params,
  );
  if (!old) throw new Error("Fixture connection missing");
  await mcpServerPool.cleanupSession("idle-source");
  let release!: () => void;
  vi.mocked(old.cleanup).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const changed = { ...params, url: "https://changed.example/mcp" };
  const invalidate = mcpServerPool.invalidateIdleSession(params.uuid, changed);
  const borrowed = await mcpServerPool.getSession(
    "borrower",
    params.uuid,
    changed,
  );
  expect(borrowed).not.toBe(old);
  release();
  await invalidate;
  expect(old.cleanup).toHaveBeenCalledOnce();
});

it("serves calls in more than five downstream sessions without DELETE by reclaiming unused upstream connections", async () => {
  const clients: ConnectedClient[] = [];
  for (let i = 0; i < 20; i++) {
    await mcpServerPool.withSessionActivity(`chatgpt-${i}`, async () => {
      const client = await mcpServerPool.getSession(
        `chatgpt-${i}`,
        params.uuid,
        { ...params, oauth_user_id: "alice" },
      );
      expect(client, `connection for logical session ${i + 1}`).toBeDefined();
      if (client) clients.push(client);
    });
    expect(mcpServerPool.getPoolStatus().active).toBeLessThanOrEqual(5);
  }
  expect(new Set(clients).size).toBe(20);
  expect(clients[0]?.cleanup).toHaveBeenCalledOnce();
});
it("handles an upstream process crash during initialization without a temporal-dead-zone exception", async () => {
  vi.mocked(connectMetaMcpClient).mockImplementationOnce(
    async (_params, crash) => {
      crash?.(1, null);
      return undefined;
    },
  );
  await expect(
    mcpServerPool.getSession("early-crash", params.uuid, {
      ...params,
      oauth_user_id: "alice",
    }),
  ).resolves.toBeUndefined();
});

it("does not reclaim connections while their owning sessions have in-flight work", async () => {
  const releases: Array<() => void> = [];
  const running = Array.from({ length: 5 }, (_, i) =>
    mcpServerPool.withSessionActivity(`busy-${i}`, async () => {
      await mcpServerPool.getSession(`busy-${i}`, params.uuid, {
        ...params,
        oauth_user_id: "alice",
      });
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    }),
  );
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(5));
    expect(
      await mcpServerPool.getSession("busy-sixth", params.uuid, {
        ...params,
        oauth_user_id: "alice",
      }),
    ).toBeUndefined();
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(5);
  } finally {
    releases.forEach((release) => release());
    await Promise.all(running);
  }
  expect(
    await mcpServerPool.getSession("after-drain", params.uuid, {
      ...params,
      oauth_user_id: "alice",
    }),
  ).toBeDefined();
});
it("keeps a reclaimed slot reserved until the old process has actually closed", async () => {
  const clients: ConnectedClient[] = [];
  for (let i = 0; i < 5; i++) {
    const client = await mcpServerPool.getSession(`old-${i}`, params.uuid, {
      ...params,
      oauth_user_id: "alice",
    });
    if (client) clients.push(client);
  }
  const releases: Array<() => void> = [];
  for (const client of clients)
    vi.mocked(client.cleanup).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
  const replacements = Array.from({ length: 5 }, (_, i) =>
    mcpServerPool.getSession(`new-${i}`, params.uuid, {
      ...params,
      oauth_user_id: "alice",
    }),
  );
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(5));
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(5);
    expect(
      await mcpServerPool.getSession("too-many", params.uuid, {
        ...params,
        oauth_user_id: "alice",
      }),
    ).toBeUndefined();
  } finally {
    releases.forEach((release) => release());
    await Promise.all(replacements);
  }
  expect(connectMetaMcpClient).toHaveBeenCalledTimes(10);
  expect(mcpServerPool.getPoolStatus().active).toBe(5);
});

it("reserves the retiring server's slot when global pressure replaces a different upstream", async () => {
  const personal = { ...params, oauth_user_id: "alice" };
  const retiring = await mcpServerPool.getSession(
    "oldest",
    params.uuid,
    personal,
  );
  if (!retiring) throw new Error("Fixture connection was not created");
  let releaseRetiring: (() => void) | undefined;
  vi.mocked(retiring.cleanup).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseRetiring = resolve;
      }),
  );
  const releases: Array<() => void> = [];
  const busy = Array.from({ length: 4 }, (_, i) =>
    mcpServerPool.withSessionActivity(`busy-${i}`, async () => {
      await mcpServerPool.getSession(`busy-${i}`, params.uuid, personal);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    }),
  );
  let replacement: Promise<ConnectedClient | undefined> | undefined;
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    for (let i = 0; i < 95; i++)
      await mcpServerPool.getSession(`filler-${i}`, `server-${i}`, {
        ...personal,
        uuid: `server-${i}`,
      });
    replacement = mcpServerPool.getSession("new-server", "new-server", {
      ...personal,
      uuid: "new-server",
    });
    await vi.waitFor(() => expect(releaseRetiring).toBeDefined());
    expect(
      await mcpServerPool.getSession("sixth", params.uuid, personal),
    ).toBeUndefined();
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(100);
  } finally {
    releaseRetiring?.();
    releases.forEach((release) => release());
    await Promise.all([...busy, replacement]);
  }
  expect(mcpServerPool.getPoolStatus().active).toBe(100);
});
