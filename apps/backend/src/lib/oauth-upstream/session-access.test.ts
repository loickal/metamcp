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

it("preserves OAuth and API-key ownership and rejects changed namespace routing", () => {
  for (const auth of [
    { oauthUserId: "alice" },
    { apiKeyUserId: "alice", apiKeyUuid: "key-a" },
  ]) {
    const access = createSessionAccess();
    const request = Object.assign(req(undefined, "unused", "session"), {
      ...auth,
      endpointName: "loic",
      namespaceUuid: "ns-a",
    });
    access.bind("session", request);
    const next = vi.fn();
    access.check(request, {} as Response, next);
    expect(next).toHaveBeenCalledOnce();
    for (const changed of [
      { namespaceUuid: "ns-b" },
      { endpointName: "other" },
      "oauthUserId" in auth ? { oauthUserId: "bob" } : { apiKeyUuid: "key-b" },
    ]) {
      const response = { status: vi.fn().mockReturnThis(), end: vi.fn() };
      const denied = vi.fn();
      access.check(
        Object.assign({}, request, changed),
        response as unknown as Response,
        denied,
      );
      expect(response.status).toHaveBeenCalledWith(404);
      expect(denied).not.toHaveBeenCalled();
    }
  }
});
it("rejects conflicting header/query session IDs before SSE message routing", () => {
  const access = createSessionAccess();
  access.bind("alice-session", req("alice", "endpoint-a"));
  const request = req("alice", "endpoint-a", "alice-session");
  request.query.sessionId = "bob-session";
  const response = { status: vi.fn().mockReturnThis(), end: vi.fn() };
  const next = vi.fn();
  access.check(request, response as unknown as Response, next);
  expect(response.status).toHaveBeenCalledWith(404);
  expect(next).not.toHaveBeenCalled();
});
