import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isMcpSessionMiss,
  requestWithMcpSessionRecovery,
} from "./mcp-session-recovery";

test("session 404 creates a fresh session before retrying safe discovery", async () => {
  let session = "expired";
  let attempts = 0;
  const result = await requestWithMcpSessionRecovery(
    "tools/list",
    async () => {
      attempts++;
      if (session === "expired")
        throw new Error(
          "Error POSTing to endpoint (HTTP 404): Session not found",
        );
      return ["Coolify__list_servers"];
    },
    async () => {
      session = "new";
    },
  );
  assert.deepEqual(result, ["Coolify__list_servers"]);
  assert.equal(attempts, 2);
});
test("session 404 reconnects but never replays a tool execution", async () => {
  let attempts = 0;
  let reconnects = 0;
  await assert.rejects(
    requestWithMcpSessionRecovery(
      "tools/call",
      async () => {
        attempts++;
        throw { code: 404 };
      },
      async () => {
        reconnects++;
      },
    ),
    /not replayed/,
  );
  assert.equal(attempts, 1);
  assert.equal(reconnects, 1);
});
test("401 and network failures do not cause blind session/request retries", async () => {
  let reconnects = 0;
  for (const error of [{ status: 401 }, new Error("Failed to fetch")]) {
    await assert.rejects(
      requestWithMcpSessionRecovery(
        "tools/list",
        async () => {
          throw error;
        },
        async () => {
          reconnects++;
        },
      ),
    );
  }
  assert.equal(reconnects, 0);
  assert.equal(isMcpSessionMiss({ status: 404 }), true);
});
test("a second 404 fails rather than looping indefinitely", async () => {
  let attempts = 0;
  let reconnects = 0;
  await assert.rejects(
    requestWithMcpSessionRecovery(
      "tools/list",
      async () => {
        attempts++;
        throw new Error("HTTP 404");
      },
      async () => {
        reconnects++;
      },
    ),
    /404/,
  );
  assert.equal(attempts, 2);
  assert.equal(reconnects, 1);
});
