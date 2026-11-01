# Deploying user-scoped upstream OAuth

Migration: `apps/backend/drizzle/0019_user_scoped_upstream_oauth.sql`.

1. Schedule an OAuth reconnect window. Back up the database securely, and stop **all** old backend instances so they cannot read or recreate unscoped sessions during migration. Avoid a rolling mixed-version deployment.
2. Revoke old upstream authorizations/client secrets at their providers where appropriate. The migration deletes **all existing `oauth_sessions` records**, including tokens, client registrations and in-flight state. Their authorizing user cannot be recovered reliably, including for private servers; assigning them to a current server owner would be unsafe. It preserves MCP server configurations, namespaces, and non-OAuth configuration.
3. Keep the existing `BETTER_AUTH_SECRET` stable and private (at least 32 characters). Build the workspace packages, apply the normal Drizzle migration command (`pnpm --filter backend db:migrate` with the deployment environment), and start the new build. The migration adds a required user foreign key, user/server uniqueness and flow expiration. Future credentials are encrypted by the repository.
4. Each user reconnects their OAuth MCP servers. Dynamic registration runs automatically. For providers without DCR, each user must re-enter their pre-registered client configuration; register exactly `${APP_URL with trailing slash removed}/fe-oauth/callback`. Do not restore old unscoped records into the new schema.
5. Open `https://code.pulseflow.ch/api/v4/mcp` through its saved MetaMCP configuration and connect. Complete the GitLab consent redirect, then list tools. Browser network traffic should contain only MetaMCP API/proxy calls and the interactive authorization/callback navigation, with no browser requests to upstream metadata, registration or token endpoints. No GitLab CORS/TLS changes are required.
6. Repeat with two MetaMCP users against a public server configuration. Each must authorize independently; disconnect/reconnect and refresh must retain their respective upstream identities. Verify a non-OAuth server still connects.

Rollback requires stopping the new build and restoring a pre-migration database backup with its matching application version. Such a rollback restores the old credential-sharing weakness; prefer rolling forward and reauthorizing. Existing upstream grants are not revoked automatically by deleting local records.

Local verification:

```sh
pnpm install --frozen-lockfile
pnpm --filter @repo/zod-types build
pnpm --filter @repo/trpc build
pnpm --filter backend test
pnpm --filter backend exec tsc --noEmit
pnpm --filter frontend check-types
pnpm --filter backend lint
pnpm build
```

The PostgreSQL migration/isolation tests additionally require `TEST_DATABASE_URL` pointing to a **disposable local database whose name ends in `_oauth_test`**. They recreate three fixture tables in that database. With that variable set, `pnpm --filter backend test` runs the migration, encrypted-storage and concurrent-state tests instead of skipping them. Never point it at a real application database.

This repository has no `make check` target. The commands above are the available checks. Live GitLab login and deployment are performed by the operator. Multi-replica refresh deduplication is a known limitation; use one backend replica for this flow.
