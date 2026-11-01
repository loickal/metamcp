import { createHash } from "node:crypto";

import {
  DatabaseOAuthSession,
  OAuthSessionCreateInput,
  OAuthSessionUpdateInput,
} from "@repo/zod-types";
import { and, eq, gt, sql } from "drizzle-orm";

import {
  openOAuthSecret,
  sealOAuthSecret,
} from "../../lib/oauth-upstream/secrets";
import { db } from "../index";
import { oauthSessionsTable } from "../schema";

type StoredSession = typeof oauthSessionsTable.$inferSelect;
const stateHash = (state: string) =>
  createHash("sha256").update(state).digest("hex");
const scope = (server: string, user: string) => {
  if (!user) throw new Error("OAuth user identity is required");
  return and(
    eq(oauthSessionsTable.mcp_server_uuid, server),
    eq(oauthSessionsTable.user_id, user),
  );
};
const context = (
  row: { user_id: string; mcp_server_uuid: string },
  field: string,
) => JSON.stringify([row.user_id, row.mcp_server_uuid, field]);

function decode(
  row: StoredSession | undefined,
): DatabaseOAuthSession | undefined {
  if (!row) return undefined;
  return {
    ...row,
    client_information: row.client_information
      ? openOAuthSecret(
          row.client_information,
          context(row, "client_information"),
        )
      : null,
    tokens: row.tokens
      ? openOAuthSecret(row.tokens, context(row, "tokens"))
      : null,
    code_verifier: row.code_verifier
      ? openOAuthSecret(row.code_verifier, context(row, "code_verifier"))
      : null,
  };
}

function encode(input: OAuthSessionUpdateInput) {
  if (!input.user_id) throw new Error("OAuth user identity is required");
  return {
    ...(input.client_information !== undefined && {
      client_information: sealOAuthSecret(
        input.client_information,
        context(input, "client_information"),
      ),
    }),
    ...(input.tokens !== undefined && {
      tokens:
        input.tokens === null
          ? null
          : sealOAuthSecret(input.tokens, context(input, "tokens")),
    }),
    ...(input.code_verifier !== undefined && {
      code_verifier:
        input.code_verifier === null
          ? null
          : sealOAuthSecret(
              input.code_verifier,
              context(input, "code_verifier"),
            ),
    }),
    ...(input.expected_state !== undefined && {
      expected_state:
        input.expected_state === null ? null : stateHash(input.expected_state),
    }),
    ...(input.flow_expires_at !== undefined && {
      flow_expires_at: input.flow_expires_at,
    }),
  };
}

export class OAuthSessionsRepository {
  async findByMcpServerUuid(server: string, user: string) {
    const [row] = await db
      .select()
      .from(oauthSessionsTable)
      .where(scope(server, user))
      .limit(1);
    return decode(row);
  }

  async create(input: OAuthSessionCreateInput): Promise<DatabaseOAuthSession> {
    const [row] = await db
      .insert(oauthSessionsTable)
      .values({
        mcp_server_uuid: input.mcp_server_uuid,
        user_id: input.user_id,
        ...encode(input),
      })
      .returning();
    const session = decode(row);
    if (!session) throw new Error("Failed to save OAuth session");
    return session;
  }

  async update(input: OAuthSessionUpdateInput) {
    const [row] = await db
      .update(oauthSessionsTable)
      .set({ ...encode(input), updated_at: sql`NOW()` })
      .where(scope(input.mcp_server_uuid, input.user_id))
      .returning();
    return decode(row);
  }

  // Atomically claim a live flow BEFORE contacting the token endpoint. NULL,
  // expired, mismatched and concurrently replayed states all fail closed.
  async consumeState(server: string, user: string, state: string) {
    const [row] = await db
      .update(oauthSessionsTable)
      .set({ expected_state: null, flow_expires_at: null })
      .where(
        and(
          scope(server, user),
          eq(oauthSessionsTable.expected_state, stateHash(state)),
          gt(oauthSessionsTable.flow_expires_at, sql`NOW()`),
        ),
      )
      .returning();
    return decode(row);
  }

  async upsert(input: OAuthSessionUpdateInput): Promise<DatabaseOAuthSession> {
    const fields = encode(input);
    const [row] = await db
      .insert(oauthSessionsTable)
      .values({
        mcp_server_uuid: input.mcp_server_uuid,
        user_id: input.user_id,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [
          oauthSessionsTable.user_id,
          oauthSessionsTable.mcp_server_uuid,
        ],
        set: { ...fields, updated_at: sql`NOW()` },
      })
      .returning();
    if (!row) throw new Error("Failed to save OAuth session");
    const session = decode(row);
    if (!session) throw new Error("Failed to save OAuth session");
    return session;
  }

  async deleteByMcpServerUuid(server: string, user: string) {
    const [row] = await db
      .delete(oauthSessionsTable)
      .where(scope(server, user))
      .returning();
    return decode(row);
  }
}

export const oauthSessionsRepository = new OAuthSessionsRepository();
