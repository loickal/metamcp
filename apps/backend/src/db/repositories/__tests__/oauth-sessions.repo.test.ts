import { readFileSync } from "node:fs";

import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Only an explicitly selected disposable database is used. Never use DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
vi.mock("../../index", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  return { pool, db: drizzle(pool) };
});

describe.skipIf(!url)("user-scoped OAuth repository (PostgreSQL)", () => {
  let pool: Pool;
  let repo: InstanceType<
    typeof import("../oauth-sessions.repo").OAuthSessionsRepository
  >;
  const server = "00000000-0000-0000-0000-000000000001";
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      !target.pathname.endsWith("_oauth_test")
    ) {
      throw new Error("Use a disposable local database ending in _oauth_test");
    }
    process.env.BETTER_AUTH_SECRET =
      "synthetic-test-key-at-least-32-characters";
    const database = await import("../../index");
    pool = database.pool;
    await pool.query(`DROP TABLE IF EXISTS oauth_sessions, mcp_servers, users CASCADE;
      CREATE TABLE users (id text PRIMARY KEY);
      CREATE TABLE mcp_servers (uuid uuid PRIMARY KEY);
      INSERT INTO users VALUES ('alice'), ('bob');
      INSERT INTO mcp_servers VALUES ('${server}');
      CREATE TABLE oauth_sessions (
        uuid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        mcp_server_uuid uuid NOT NULL REFERENCES mcp_servers(uuid),
        client_information jsonb NOT NULL DEFAULT '{}', tokens jsonb,
        code_verifier text, expected_state text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT oauth_sessions_unique_per_server_idx UNIQUE(mcp_server_uuid));
      INSERT INTO oauth_sessions(mcp_server_uuid,tokens,expected_state) VALUES ('${server}', '{"access_token":"legacy-secret"}', 'legacy-state');`);
    const migration = readFileSync(
      new URL(
        "../../../../drizzle/0019_user_scoped_upstream_oauth.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(migration);
    expect(
      (await pool.query("SELECT count(*) FROM oauth_sessions")).rows[0].count,
    ).toBe("0");
    const { OAuthSessionsRepository } = await import("../oauth-sessions.repo");
    repo = new OAuthSessionsRepository();
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM oauth_sessions");
  });

  it("isolates concurrent upserts and encrypts tokens, secrets and PKCE at rest", async () => {
    await Promise.all(
      ["alice", "bob"].map((user) =>
        repo.upsert({
          mcp_server_uuid: server,
          user_id: user,
          client_information: {
            client_id: user,
            client_secret: `${user}-secret`,
          },
          tokens: {
            access_token: `${user}-access`,
            refresh_token: `${user}-refresh`,
            token_type: "Bearer",
          },
          code_verifier: `${user}-verifier`,
        }),
      ),
    );
    for (const user of ["alice", "bob"]) {
      const session = await repo.findByMcpServerUuid(server, user);
      expect(session?.tokens?.access_token).toBe(`${user}-access`);
      expect(session?.client_information?.client_secret).toBe(`${user}-secret`);
    }
    const stored = JSON.stringify(
      (await pool.query("SELECT * FROM oauth_sessions")).rows,
    );
    for (const secret of [
      "alice-access",
      "alice-secret",
      "alice-refresh",
      "alice-verifier",
      "bob-access",
    ])
      expect(stored).not.toContain(secret);
    await repo.deleteByMcpServerUuid(server, "alice");
    expect(await repo.findByMcpServerUuid(server, "alice")).toBeUndefined();
    expect(
      (await repo.findByMcpServerUuid(server, "bob"))?.tokens?.access_token,
    ).toBe("bob-access");
  });

  it("persists state on insert/update and consumes it once under concurrent callbacks", async () => {
    await repo.upsert({
      mcp_server_uuid: server,
      user_id: "alice",
      expected_state: "first",
      code_verifier: "pkce",
      flow_expires_at: new Date(Date.now() + 60000),
    });
    await repo.upsert({
      mcp_server_uuid: server,
      user_id: "alice",
      expected_state: "second",
    });
    expect(await repo.consumeState(server, "alice", "first")).toBeUndefined();
    expect(await repo.consumeState(server, "bob", "second")).toBeUndefined();
    const claimed = await Promise.all([
      repo.consumeState(server, "alice", "second"),
      repo.consumeState(server, "alice", "second"),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(await repo.consumeState(server, "alice", "second")).toBeUndefined();
  });

  it("rejects expired/null state, missing identity, and ciphertext transplanted to another user", async () => {
    await repo.upsert({
      mcp_server_uuid: server,
      user_id: "alice",
      tokens: { access_token: "secret", token_type: "Bearer" },
      expected_state: "expired",
      flow_expires_at: new Date(0),
    });
    expect(await repo.consumeState(server, "alice", "expired")).toBeUndefined();
    await expect(repo.findByMcpServerUuid(server, "")).rejects.toThrow(
      "identity",
    );
    await pool.query("UPDATE oauth_sessions SET user_id = 'bob'");
    await expect(repo.findByMcpServerUuid(server, "bob")).rejects.toThrow();
  });

  it("partial token writes preserve client config; explicit null clears credentials", async () => {
    await repo.upsert({
      mcp_server_uuid: server,
      user_id: "alice",
      client_information: { client_id: "client" },
      tokens: { access_token: "old", token_type: "Bearer" },
    });
    await repo.upsert({
      mcp_server_uuid: server,
      user_id: "alice",
      tokens: { access_token: "new", token_type: "Bearer" },
    });
    expect(
      (await repo.findByMcpServerUuid(server, "alice"))?.client_information
        ?.client_id,
    ).toBe("client");
    await repo.upsert({
      mcp_server_uuid: server,
      user_id: "alice",
      tokens: null,
      code_verifier: null,
    });
    expect(
      (await repo.findByMcpServerUuid(server, "alice"))?.tokens,
    ).toBeNull();
  });
});
