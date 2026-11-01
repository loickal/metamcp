import type { Request, Response } from "express";
import { expect, it, vi } from "vitest";

import { createSessionAccess } from "./session-access";

const req = (user: string | undefined, endpoint: string, session?: string) =>
  ({
    user: user ? { id: user } : undefined,
    params: { uuid: endpoint },
    query: {},
    get: () => session,
  }) as unknown as Request;
it("binds resumed sessions and deletes to user and endpoint, including public requests", () => {
  const access = createSessionAccess();
  access.bind("session", req("alice", "endpoint-a"));
  for (const request of [
    req("bob", "endpoint-a", "session"),
    req(undefined, "endpoint-a", "session"),
    req("alice", "endpoint-b", "session"),
  ]) {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), end: vi.fn() };
    access.check(request, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  }
  const next = vi.fn();
  access.check(req("alice", "endpoint-a", "session"), {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
});
