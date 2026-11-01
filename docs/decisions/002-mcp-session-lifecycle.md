# MCP session ownership and recovery

Date: 2026-11-01. Applies to the Inspector and public SSE/Streamable HTTP endpoints.

## Evidence

The real-SDK Express regression initialized the Inspector successfully, consumed
its HTTP response, then received HTTP 404 on tools/list with the issued session
ID. Removing response-close cleanup alone still failed: the ownership middleware
ran before Express populated the namespace parameter. With ownership placement
corrected, restoring response-close cleanup independently reproduced the 404.
Both corrections are necessary.

The public transport previously retained its session while the MetaMCP server
pool independently expired the underlying server by creation time. Discovery
also returned partial tools as success after upstream failures, and recovery of
one upstream connection closed every user's connection to that server. Cached
client pointers could outlive those connections. These paths are covered by
controlled regression fixtures; they are not a claim that every reported
production error has the same cause.

## Decision

Use one lifecycle implementation for Inspector/public transports:
INITIALIZING -> ACTIVE -> CLOSING -> CLOSED. Connect the SDK server before
publishing an active transport. Track last activity and actual RPC work, not just
HTTP response lifetime. Cleanup is shared by concurrent callers and drains work
before releasing resources. Idle sweeps cannot overlap or expire active work.

HTTP response completion and optional Streamable HTTP GET/SSE disconnection do
not terminate the MCP session. Explicit DELETE, transport closure, configured
idle expiration, and process shutdown do. Legacy SSE disconnection terminates
its connection-bound session. GET streams do not block DELETE's drain barrier.
Malformed request errors alone do not close a healthy transport.

Bind requests to the authenticated user, API key where applicable, endpoint and
namespace. Conflicting header/query session IDs are rejected. Inspector namespace
access is checked on every request. OAuth discovery, encrypted credentials and
per-user token exchange/refresh remain unchanged.

SDK server instances capture their session/auth context and cannot be rebound
from namespace idle IDs. Create them once per session, deduplicate concurrent
creation, and let the transport lifecycle own their cleanup. Upstream clients
remain separately pooled: reserve connection capacity before asynchronous
initialization; never lend active clients across downstream sessions; never
recycle personal or forwarded credentials. Configuration changes invalidate
stale clients. No new infrastructure or schema changes are required.

For metadata reads, invalidate only the failed client (compare-and-remove),
reconnect once, and retry. Namespace discovery fails explicitly if any enabled
upstream cannot be listed. Diagnostic ERROR state does not remove an enabled
server from discovery. Calls resolve current namespace configuration and check
metadata on the current/recovered connection before execution. A failed tool
invocation is never automatically replayed, because execution may have occurred.
Permission lookup failures fail closed. There is no last-known-good tool cache.

The Inspector uses Streamable HTTP for namespaces, serializes initialization,
closes cancelled initialization, and reinitializes after HTTP 404 without the old
session ID. Only safe metadata operations are replayed. Unmount cleanup no longer
runs on every connection-status transition.

## Operations and deployment

Read-only Coolify inspection found one configured replica, no additional servers,
and deployment bf818bd3. Its November 1 deployment log confirms old/new container
overlap during a rolling update, including a five-second proxy handover interval.
The 500-line application log sample contained connection churn but no matching
session-miss, unknown-tool or RSC failure. Client error timestamps were not
available, so RSC failures cannot be correlated to a restart from this evidence.
Next.js serves RSC and proxies MCP to the colocated Express process; they are
separate request paths. Deployment configuration was not modified.

Live MCP transport objects are process-local. Route a session consistently to its
owning instance for its lifetime (session affinity during overlap), or drain and
cut over to one instance. Do not round-robin a session across replicas. After its
owner exits, a 404 is correct and clients must initialize a new session; Redis
metadata alone would not reconstruct the transport. External ChatGPT recovery
must be verified during deployment. See the MCP [session management specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management).

Existing SESSION_LIFETIME configuration is interpreted as an **idle** timeout in
milliseconds; null still means infinite, subject to capacity limits. Operators
wanting abandoned sessions to expire must configure a finite timeout. Transport
registries and the SDK server pool each cap reservations at 1,000. Existing
upstream limits (MAX_TOTAL_CONNECTIONS, and five connections per upstream) now
reject excess demand instead of sharing another session's active client.
Capacity failures are explicit; increasing replicas alone does not fix routing.

Logs include boot/request IDs, a boot-salted session fingerprint, lifecycle
reasons/age/activity, recovery outcomes and discovery counts. X-Request-Id and
X-MetaMCP-Instance identify requests/owners. The existing public session-health
endpoint exposes aggregate counts/counters only, not session IDs or credentials.
Counters reset at restart. Shutdown stops accepting new connections, drains
sessions, then closes pools, with a ten-second process deadline.

Deploy after merging to ai-dev, then verify repeated Inspector and ChatGPT
list/call operations against the real upstreams, a deliberate upstream reconnect,
and a redeployment. Local fixtures cannot prove provider or proxy behavior.
Rollback to the previous image/commit requires no database rollback and preserves
the OAuth security changes already in bf818bd3. Any restart/rollback requires
clients to establish new in-memory sessions. No production resources or data
were modified while implementing this change.

## Regression checks

- `pnpm --filter backend test`: lifecycle, pool concurrency/isolation, metadata
  recovery, enabled tools after recovery, no side-effect replay, permission
  failures, OAuth/API-key session ownership and existing OAuth tests.
- `pnpm --filter backend exec tsx --test ../frontend/lib/mcp-session-recovery.test.ts`:
  Inspector 404 recovery and safe-only retry.
- Backend/frontend TypeScript checks and ESLint on changed files.
- The PostgreSQL OAuth repository suite requires an explicitly selected disposable
  TEST_DATABASE_URL. `make check` is unavailable in this repository.
