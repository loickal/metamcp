import { createHash } from "node:crypto";

import { ServerParameters } from "@repo/zod-types";

import logger from "@/utils/logger";

import { configService } from "../config.service";
import { mcpEvent } from "../mcp-diagnostics";
import { ConnectedClient, connectMetaMcpClient } from "./client";
import { serverRequiresForwardedHeaders } from "./header-forwarding";
import { metamcpLogStore } from "./log-store";
import { serverErrorTracker } from "./server-error-tracker";

export interface McpServerPoolStatus {
  idle: number;
  active: number;
  activeSessionIds: string[];
  idleServerUuids: string[];
  perServerCounts?: Record<string, number>;
  maxConnectionsPerServer?: number;
}

export class McpServerPool {
  // Singleton instance
  private static instance: McpServerPool | null = null;

  // Idle sessions: serverUuid -> ConnectedClient (no sessionId assigned yet)
  private idleSessions: Record<string, ConnectedClient> = {};

  // Active sessions: sessionId -> Record<serverUuid, ConnectedClient>
  private activeSessions: Record<string, Record<string, ConnectedClient>> = {};

  // Mapping: sessionId -> Set<serverUuid> for cleanup tracking
  private sessionToServers: Record<string, Set<string>> = {};

  // Session creation timestamps: sessionId -> timestamp
  private sessionTimestamps: Record<string, number> = {};

  // Server parameters cache: serverUuid -> ServerParameters
  private serverParamsCache: Record<string, ServerParameters> = {};

  // Track ongoing idle session creation to prevent duplicates
  private creatingIdleSessions: Set<string> = new Set();

  // Generation counter per server UUID: incremented by invalidateIdleSession() so
  // any in-flight createIdleSession / createIdleSessionAsync that resolves with a
  // stale generation knows to discard its result instead of storing it.
  private idleSessionGenerations: Record<string, number> = {};

  // Session cleanup timer
  private cleanupTimer: NodeJS.Timeout | null = null;

  // Health check timer for idle sessions
  private healthCheckTimer: NodeJS.Timeout | null = null;

  // Background idle sessions by namespace: namespaceUuid -> any
  private backgroundIdleSessionsByNamespace: Map<string, Map<string, unknown>> =
    new Map();

  // Default number of idle sessions per server UUID
  private readonly defaultIdleCount: number;

  // Maximum total connections (idle + active) to prevent runaway process spawning
  private readonly maxTotalConnections: number;

  // Maximum connections per individual server UUID (prevents per-server process explosion)
  private readonly maxConnectionsPerServer: number;

  private constructor(
    defaultIdleCount: number = 1,
    maxTotalConnections: number = parseInt(
      process.env.MAX_TOTAL_CONNECTIONS || "100",
      10,
    ),
    maxConnectionsPerServer: number = 5,
  ) {
    this.defaultIdleCount = defaultIdleCount;
    this.maxTotalConnections = maxTotalConnections;
    this.maxConnectionsPerServer = maxConnectionsPerServer;
    this.startCleanupTimer();
    this.startHealthCheckTimer();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(
    defaultIdleCount: number = 1,
    maxConnectionsPerServer: number = 5,
  ): McpServerPool {
    if (!McpServerPool.instance) {
      const envMax = parseInt(process.env.MAX_TOTAL_CONNECTIONS || "", 10);
      const maxConn = Number.isFinite(envMax) && envMax > 0 ? envMax : 100;
      McpServerPool.instance = new McpServerPool(
        defaultIdleCount,
        maxConn,
        maxConnectionsPerServer,
      );
    }
    return McpServerPool.instance;
  }

  /**
   * Count all connections (idle + active + pending) for a specific server UUID
   */
  private countConnectionsForServer(serverUuid: string): number {
    let count = 0;

    // Count idle session
    if (this.idleSessions[serverUuid]) {
      count += 1;
    }

    // Count active sessions across all sessionIds
    for (const sessionServers of Object.values(this.activeSessions)) {
      if (sessionServers[serverUuid]) {
        count += 1;
      }
    }

    // Count pending idle creation
    if (this.creatingIdleSessions.has(serverUuid)) {
      count += 1;
    }

    count += [...this.pending.values()].filter(
      (entry) => entry.serverUuid === serverUuid,
    ).length;
    return count;
  }

  /**
   * Check if we can create another connection for a specific server
   */
  private canCreateConnectionForServer(serverUuid: string): boolean {
    const count = this.countConnectionsForServer(serverUuid);
    if (count >= this.maxConnectionsPerServer) {
      logger.warn(
        `Per-server connection limit reached for ${serverUuid}: ${count}/${this.maxConnectionsPerServer}`,
      );
      return false;
    }
    return true;
  }

  private fingerprints = new WeakMap<ConnectedClient, string>();
  private fingerprint(params: ServerParameters) {
    // Only connection-affecting configuration. OAuth token rotation and
    // diagnostic/status updates must not churn an otherwise healthy transport.
    const configuration = [
      params.type,
      params.url,
      params.command,
      params.args,
      params.env,
      params.headers,
      params.forward_headers,
      params.bearerToken,
      params.oauth_user_id,
      params.stderr,
    ];
    return createHash("sha256")
      .update(JSON.stringify(configuration))
      .digest("hex");
  }
  private pending = new Map<
    string,
    {
      sessionId: string;
      serverUuid: string;
      userId?: string;
      fingerprint: string;
      promise: Promise<ConnectedClient | undefined>;
    }
  >();
  private closing = new Map<string, Promise<void>>();
  private inFlight = new Map<string, number>();
  private drained = new Map<string, () => void>();
  private privateClients = new WeakSet<ConnectedClient>();
  private stopping = false;
  private healthChecking = false;

  async withSessionActivity<T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.stopping || this.closing.has(sessionId))
      throw new Error("MCP session closing");
    this.inFlight.set(sessionId, (this.inFlight.get(sessionId) ?? 0) + 1);
    this.sessionTimestamps[sessionId] = Date.now();
    try {
      return await fn();
    } finally {
      this.sessionTimestamps[sessionId] = Date.now();
      const count = (this.inFlight.get(sessionId) ?? 1) - 1;
      if (count) this.inFlight.set(sessionId, count);
      else {
        this.inFlight.delete(sessionId);
        this.drained.get(sessionId)?.();
      }
    }
  }

  async getSession(
    sessionId: string,
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<ConnectedClient | undefined> {
    if (this.stopping || this.closing.has(sessionId)) return undefined;
    const personal =
      !!params.oauth_user_id || serverRequiresForwardedHeaders(params);
    if (!personal) this.serverParamsCache[serverUuid] = params;
    const existing = this.activeSessions[sessionId]?.[serverUuid];
    if (existing) {
      if (this.fingerprints.get(existing) !== this.fingerprint(params)) {
        if (existing.oauthUserId !== params.oauth_user_id)
          throw new Error("Upstream session identity mismatch");
        await this.invalidateServerConnection(sessionId, serverUuid, existing);
        return this.getSession(sessionId, serverUuid, params, namespaceUuid);
      }
      if (existing.oauthUserId !== params.oauth_user_id)
        throw new Error("Upstream session identity mismatch");
      this.sessionTimestamps[sessionId] = Date.now();
      return existing;
    }
    const key = JSON.stringify([sessionId, serverUuid]);
    const pending = this.pending.get(key);
    if (pending) {
      if (pending.userId !== params.oauth_user_id)
        throw new Error("Upstream session identity mismatch");
      if (pending.fingerprint !== this.fingerprint(params)) {
        await pending.promise;
        return this.getSession(sessionId, serverUuid, params, namespaceUuid);
      }
      return pending.promise;
    }
    this.activeSessions[sessionId] ??= {};
    this.sessionToServers[sessionId] ??= new Set();
    this.sessionTimestamps[sessionId] = Date.now();
    if (!personal && this.idleSessions[serverUuid]) {
      const idle = this.idleSessions[serverUuid];
      delete this.idleSessions[serverUuid];
      if (this.fingerprints.get(idle) !== this.fingerprint(params)) {
        await idle.cleanup();
        return this.getSession(sessionId, serverUuid, params, namespaceUuid);
      }
      this.activeSessions[sessionId][serverUuid] = idle;
      this.sessionToServers[sessionId].add(serverUuid);
      return idle;
    }
    // Reserve before the asynchronous connect. Never borrow an active client
    // from another downstream session, even when all slots are occupied.
    if (
      !this.canCreateConnectionForServer(serverUuid) ||
      !this.canCreateConnection()
    )
      return undefined;
    const promise = Promise.resolve()
      .then(async () => {
        const client = await this.createNewConnection(
          params,
          namespaceUuid,
          true,
        );
        if (!client) return undefined;
        if (this.stopping || this.closing.has(sessionId)) {
          await client.cleanup();
          return undefined;
        }
        client.oauthUserId = params.oauth_user_id;
        if (personal) this.privateClients.add(client);
        this.activeSessions[sessionId][serverUuid] = client;
        this.sessionToServers[sessionId].add(serverUuid);
        this.sessionTimestamps[sessionId] = Date.now();
        return client;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, {
      sessionId,
      serverUuid,
      userId: params.oauth_user_id,
      fingerprint: this.fingerprint(params),
      promise,
    });
    return promise;
  }

  /**
   * Create a new connection for a server
   */
  private async createNewConnection(
    params: ServerParameters,
    namespaceUuid?: string,
    reserved = false,
  ): Promise<ConnectedClient | undefined> {
    if (this.stopping) return undefined;
    // Check connection limit before attempting to create
    if (!reserved && !this.canCreateConnection()) {
      logger.warn(
        `Skipping connection for server ${params.name} (${params.uuid}) - connection limit reached`,
      );
      return undefined;
    }

    logger.info(
      `Creating new connection for server ${params.name} (${params.uuid}) with namespace: ${namespaceUuid || "none"}`,
    );
    metamcpLogStore.addLog(
      params.name,
      "info",
      `Creating new connection for namespace ${namespaceUuid || "none"}`,
    );

    const owner: { client?: ConnectedClient } = {};
    const connectedClient = await connectMetaMcpClient(
      params,
      (exitCode, signal) => {
        logger.info(
          `Crash handler callback called for server ${params.name} (${params.uuid}) with namespace: ${namespaceUuid || "none"}`,
        );

        // Handle process crash - always set up crash handler
        if (namespaceUuid) {
          // If we have a namespace context, use it
          this.handleServerCrash(
            params.uuid,
            namespaceUuid,
            exitCode,
            signal,
            connectedClient,
          ).catch((error) => {
            logger.error(
              `Error handling server crash for ${params.uuid} in ${namespaceUuid}:`,
              error,
            );
          });
        } else {
          // If no namespace context, still track the crash globally
          this.handleServerCrashWithoutNamespace(
            params.uuid,
            exitCode,
            signal,
            connectedClient,
          ).catch((error) => {
            logger.error(
              `Error handling server crash for ${params.uuid} (no namespace):`,
              error,
            );
          });
        }
      },
    );
    owner.client = connectedClient;
    if (!connectedClient) {
      mcpEvent("upstream_connection_failed", {
        upstream: params.uuid,
        namespace: namespaceUuid,
      });
      return undefined;
    }

    this.fingerprints.set(connectedClient, this.fingerprint(params));
    return connectedClient;
  }

  /**
   * Create an idle session for a server (blocking version for initial setup)
   */
  private async createIdleSession(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    if (
      this.stopping ||
      params.oauth_user_id ||
      serverRequiresForwardedHeaders(params)
    )
      return;
    // Don't create if we already have an idle session or are already creating one.
    // Both checks are synchronous (before any await) so they act as a pre-await
    // mutex, matching the pattern used by createIdleSessionAsync.
    if (
      this.idleSessions[serverUuid] ||
      this.creatingIdleSessions.has(serverUuid)
    ) {
      return;
    }

    // Don't create if at per-server cap
    if (
      !this.canCreateConnectionForServer(serverUuid) ||
      !this.canCreateConnection()
    ) {
      return;
    }

    this.creatingIdleSessions.add(serverUuid);
    const generation = this.idleSessionGenerations[serverUuid] ?? 0;

    try {
      const newClient = await this.createNewConnection(
        params,
        namespaceUuid,
        true,
      );
      if (newClient) {
        const currentGeneration = this.idleSessionGenerations[serverUuid] ?? 0;
        if (
          !this.stopping &&
          !this.idleSessions[serverUuid] &&
          currentGeneration === generation
        ) {
          this.idleSessions[serverUuid] = newClient;
          logger.info(`Created idle session for server ${serverUuid}`);
          metamcpLogStore.addLog(
            params.name,
            "info",
            `Created idle session for server ${serverUuid}`,
          );
        } else {
          // Either a concurrent call already stored an idle session, or
          // invalidateIdleSession() bumped the generation while we were awaiting,
          // meaning our result is stale. Discard it.
          newClient.cleanup().catch((error) => {
            logger.error(
              `Error cleaning up duplicate idle session for ${serverUuid}:`,
              error,
            );
          });
        }
      }
    } finally {
      // Only release the guard if we're still the current creation for this
      // server. If the generation was bumped while we were awaiting (e.g. by
      // invalidateIdleSession), the guard now belongs to the newer creation
      // and must not be removed here.
      if ((this.idleSessionGenerations[serverUuid] ?? 0) === generation) {
        this.creatingIdleSessions.delete(serverUuid);
      }
    }
  }

  /**
   * Create an idle session for a server asynchronously (non-blocking)
   */
  private createIdleSessionAsync(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): void {
    if (
      this.stopping ||
      params.oauth_user_id ||
      serverRequiresForwardedHeaders(params)
    )
      return;
    // Don't create if we already have an idle session or are already creating one
    if (
      this.idleSessions[serverUuid] ||
      this.creatingIdleSessions.has(serverUuid)
    ) {
      return;
    }

    // Check per-server cap before spawning a background idle
    if (
      !this.canCreateConnectionForServer(serverUuid) ||
      !this.canCreateConnection()
    ) {
      return;
    }

    // Mark that we're creating an idle session for this server
    this.creatingIdleSessions.add(serverUuid);
    const generation = this.idleSessionGenerations[serverUuid] ?? 0;

    // Create the session in the background (fire and forget)
    this.createNewConnection(params, namespaceUuid, true)
      .then((newClient) => {
        const currentGeneration = this.idleSessionGenerations[serverUuid] ?? 0;
        if (
          newClient &&
          !this.stopping &&
          !this.idleSessions[serverUuid] &&
          currentGeneration === generation
        ) {
          this.idleSessions[serverUuid] = newClient;
          logger.info(
            `Created background idle session for server [${params.name}] ${serverUuid}`,
          );
          metamcpLogStore.addLog(
            params.name,
            "info",
            `Created background idle session for server ${serverUuid}`,
          );
          if (namespaceUuid) {
            this.setBackgroundIdleSessionsByNamespace(
              namespaceUuid,
              new Map().set("status", "created"),
            );
          }
        } else if (newClient) {
          // Either we already have an idle session, or invalidateIdleSession()
          // bumped the generation while we were awaiting (stale result). Discard it.
          newClient.cleanup().catch((error) => {
            logger.error(
              `Error cleaning up extra idle session for ${serverUuid}:`,
              error,
            );
          });
        }
      })
      .catch((error) => {
        logger.error(
          `Error creating background idle session for ${serverUuid}:`,
          error,
        );
      })
      .finally(() => {
        // Only release the guard if we're still the current creation for this
        // server. If the generation was bumped while we were awaiting (e.g. by
        // invalidateIdleSession), the guard now belongs to the newer creation
        // and must not be removed here.
        if ((this.idleSessionGenerations[serverUuid] ?? 0) === generation) {
          this.creatingIdleSessions.delete(serverUuid);
        }
      });
  }

  /**
   * Ensure idle sessions exist for all servers
   */
  async ensureIdleSessions(
    serverParams: Record<string, ServerParameters>,
    namespaceUuid?: string,
  ): Promise<void> {
    const promises = Object.entries(serverParams).map(
      async ([uuid, params]) => {
        if (!this.idleSessions[uuid]) {
          await this.createIdleSession(uuid, params, namespaceUuid);
        }
      },
    );

    await Promise.allSettled(promises);
  }

  /**
   * Cleanup a session by sessionId.
   * Recycles healthy connections back to the idle pool instead of destroying them.
   */
  cleanupSession(sessionId: string): Promise<void> {
    const existingClose = this.closing.get(sessionId);
    if (existingClose) return existingClose;
    const closing = Promise.resolve()
      .then(async () => {
        if (this.inFlight.has(sessionId))
          await new Promise<void>((resolve) =>
            this.drained.set(sessionId, resolve),
          );
        await Promise.allSettled(
          [...this.pending.values()]
            .filter((entry) => entry.sessionId === sessionId)
            .map((entry) => entry.promise),
        );
        const clients = this.activeSessions[sessionId] ?? {};
        delete this.activeSessions[sessionId];
        delete this.sessionTimestamps[sessionId];
        delete this.sessionToServers[sessionId];
        await Promise.allSettled(
          Object.entries(clients).map(async ([uuid, client]) => {
            if (
              !this.stopping &&
              !client.oauthUserId &&
              !this.privateClients.has(client) &&
              !this.idleSessions[uuid]
            )
              this.idleSessions[uuid] = client;
            else await client.cleanup();
          }),
        );
      })
      .finally(() => {
        this.closing.delete(sessionId);
        this.drained.delete(sessionId);
      });
    this.closing.set(sessionId, closing);
    return closing;
  }

  /**
   * Cleanup all sessions
   */
  async cleanupAll(shutdown = false): Promise<void> {
    this.stopping = true;
    // Cleanup all active sessions
    const activeSessionIds = Object.keys(this.activeSessions);
    await Promise.allSettled(
      activeSessionIds.map((sessionId) => this.cleanupSession(sessionId)),
    );

    // Cleanup all idle sessions
    await Promise.allSettled(
      Object.entries(this.idleSessions).map(async ([_uuid, client]) => {
        await client.cleanup();
      }),
    );

    // Clear all state
    this.idleSessions = {};
    this.activeSessions = {};
    this.sessionToServers = {};
    this.sessionTimestamps = {};
    this.serverParamsCache = {};

    // Bump all known generations (never reset to {}) so any in-flight idle
    // creation that started before cleanupAll() resolves with a stale value
    // and discards itself. Cover both tracked entries and UUIDs that are only
    // in creatingIdleSessions (which default to 0 and have no map entry yet).
    for (const uuid of new Set([
      ...Object.keys(this.idleSessionGenerations),
      ...this.creatingIdleSessions,
    ])) {
      this.idleSessionGenerations[uuid] =
        (this.idleSessionGenerations[uuid] ?? 0) + 1;
    }
    this.creatingIdleSessions.clear();

    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Clear health check timer
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    logger.info("Cleaned up all MCP server pool sessions");
    this.stopping = shutdown;
  }

  /**
   * Get pool status for monitoring
   */
  getPoolStatus(): McpServerPoolStatus {
    const idle = Object.keys(this.idleSessions).length;
    const active = Object.keys(this.activeSessions).reduce(
      (total, sessionId) =>
        total + Object.keys(this.activeSessions[sessionId]).length,
      0,
    );

    // Calculate per-server breakdown
    const perServerCounts: Record<string, number> = {};
    for (const serverUuid of Object.keys(this.serverParamsCache)) {
      perServerCounts[serverUuid] = this.countConnectionsForServer(serverUuid);
    }

    return {
      idle,
      active,
      activeSessionIds: Object.keys(this.activeSessions),
      idleServerUuids: Object.keys(this.idleSessions),
      perServerCounts,
      maxConnectionsPerServer: this.maxConnectionsPerServer,
    };
  }

  /**
   * Get total connection count (idle + active + pending)
   */
  private getTotalConnectionCount(): number {
    const idle = Object.keys(this.idleSessions).length;
    const active = Object.keys(this.activeSessions).reduce(
      (total, sessionId) =>
        total + Object.keys(this.activeSessions[sessionId]).length,
      0,
    );
    const pending = this.creatingIdleSessions.size + this.pending.size;
    return idle + active + pending;
  }

  /**
   * Check if we can create a new connection (respects maxTotalConnections limit)
   */
  private canCreateConnection(): boolean {
    const total = this.getTotalConnectionCount();
    if (total >= this.maxTotalConnections) {
      logger.warn(
        `Connection limit reached: ${total}/${this.maxTotalConnections}. Refusing to create new connection.`,
      );
      return false;
    }
    return true;
  }

  /**
   * Get active session connections for a specific session (for debugging/monitoring)
   */
  getSessionConnections(
    sessionId: string,
  ): Record<string, ConnectedClient> | undefined {
    return this.activeSessions[sessionId];
  }

  /**
   * Get all active session IDs (for debugging/monitoring)
   */
  getActiveSessionIds(): string[] {
    return Object.keys(this.activeSessions);
  }

  /**
   * Get background idle sessions by namespace
   */
  getBackgroundIdleSessionsByNamespace(): Map<string, Map<string, unknown>> {
    return this.backgroundIdleSessionsByNamespace;
  }

  /**
   * Set background idle sessions by namespace
   */
  setBackgroundIdleSessionsByNamespace(
    namespaceUuid: string,
    options: Map<string, unknown>,
  ): void {
    this.backgroundIdleSessionsByNamespace.set(namespaceUuid, options);
  }

  // Compare-and-remove only the failed connection. A session-specific 404 is
  // not evidence that other users' live upstream sessions have also expired.
  async invalidateServerConnection(
    sessionId: string,
    serverUuid: string,
    expected?: ConnectedClient,
  ): Promise<void> {
    const client = this.activeSessions[sessionId]?.[serverUuid];
    if (!client || (expected && client !== expected)) return;
    delete this.activeSessions[sessionId][serverUuid];
    this.sessionToServers[sessionId]?.delete(serverUuid);
    await client.cleanup().catch(() => {});
  }

  /**
   * Invalidate and refresh idle session for a specific server
   * This should be called when a server's parameters (command, args, etc.) change
   */
  async invalidateIdleSession(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    if (!params.oauth_user_id && !serverRequiresForwardedHeaders(params))
      this.serverParamsCache[serverUuid] = params;
    else delete this.serverParamsCache[serverUuid];
    const generation = (this.idleSessionGenerations[serverUuid] ?? 0) + 1;
    this.idleSessionGenerations[serverUuid] = generation;
    this.creatingIdleSessions.delete(serverUuid);
    const previous = this.idleSessions[serverUuid];
    delete this.idleSessions[serverUuid];
    await previous?.cleanup().catch(() => {});
    if (this.idleSessionGenerations[serverUuid] === generation)
      await this.createIdleSession(serverUuid, params, namespaceUuid);
  }

  /**
   * Invalidate and refresh idle sessions for multiple servers
   */
  async invalidateIdleSessions(
    serverParams: Record<string, ServerParameters>,
    namespaceUuid?: string,
  ): Promise<void> {
    const promises = Object.entries(serverParams).map(([serverUuid, params]) =>
      this.invalidateIdleSession(serverUuid, params, namespaceUuid),
    );

    await Promise.allSettled(promises);
  }

  /**
   * Clean up idle session for a specific server without creating a new one
   * This should be called when a server is being deleted
   */
  async cleanupIdleSession(serverUuid: string): Promise<void> {
    this.idleSessionGenerations[serverUuid] =
      (this.idleSessionGenerations[serverUuid] ?? 0) + 1;
    this.creatingIdleSessions.delete(serverUuid);
    delete this.serverParamsCache[serverUuid];
    const previous = this.idleSessions[serverUuid];
    delete this.idleSessions[serverUuid];
    await previous?.cleanup().catch(() => {});
  }

  /**
   * Ensure idle session exists for a newly created server
   * This should be called when a new server is created
   */
  async ensureIdleSessionForNewServer(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    logger.info(`Ensuring idle session exists for new server ${serverUuid}`);

    // Update server params cache
    if (!params.oauth_user_id) this.serverParamsCache[serverUuid] = params;

    // Only create if we don't already have one
    if (
      !this.idleSessions[serverUuid] &&
      !this.creatingIdleSessions.has(serverUuid)
    ) {
      await this.createIdleSession(serverUuid, params, namespaceUuid);
    }
  }

  /**
   * Handle server process crash
   */
  async handleServerCrash(
    serverUuid: string,
    namespaceUuid: string,
    exitCode: number | null,
    signal: string | null,
    failedClient?: ConnectedClient,
  ): Promise<void> {
    logger.warn(
      `Handling server crash for ${serverUuid} in namespace ${namespaceUuid}`,
    );

    // Record the crash in the error tracker
    await serverErrorTracker.recordServerCrash(serverUuid, exitCode, signal);

    // Clean up any existing sessions for this server
    await this.cleanupServerSessions(serverUuid, failedClient);
  }

  /**
   * Handle server process crash without namespace context
   * This is used when servers are created without a specific namespace
   */
  async handleServerCrashWithoutNamespace(
    serverUuid: string,
    exitCode: number | null,
    signal: string | null,
    failedClient?: ConnectedClient,
  ): Promise<void> {
    logger.warn(
      `Handling server crash for ${serverUuid} (no namespace context)`,
    );

    // Record the crash in the error tracker
    logger.info(`Recording crash for server ${serverUuid}`);
    await serverErrorTracker.recordServerCrash(serverUuid, exitCode, signal);

    // Clean up any existing sessions for this server
    await this.cleanupServerSessions(serverUuid, failedClient);
  }

  /**
   * Clean up all sessions for a specific server
   */
  private async cleanupServerSessions(
    serverUuid: string,
    failedClient?: ConnectedClient,
  ): Promise<void> {
    // A crashed STDIO process belongs to one connection, not every process
    // running the same configured command for other downstream sessions.
    if (!failedClient) return;
    if (this.idleSessions[serverUuid] === failedClient) {
      delete this.idleSessions[serverUuid];
      await failedClient.cleanup().catch(() => {});
    }
    await Promise.all(
      Object.entries(this.activeSessions).map(async ([sessionId, servers]) => {
        if (servers[serverUuid] === failedClient)
          await this.invalidateServerConnection(
            sessionId,
            serverUuid,
            failedClient,
          );
      }),
    );
  }

  /**
   * Check if a server is in error state
   */
  async isServerInErrorState(serverUuid: string): Promise<boolean> {
    return await serverErrorTracker.isServerInErrorState(serverUuid);
  }

  /**
   * Reset error state for a server (e.g., after manual recovery)
   */
  async resetServerErrorState(serverUuid: string): Promise<void> {
    // Reset crash attempts and error status
    await serverErrorTracker.resetServerErrorState(serverUuid);

    logger.info(`Reset error state for server ${serverUuid}`);
  }

  /**
   * Start the automatic cleanup timer for expired sessions
   */
  private startCleanupTimer(): void {
    // Check for expired sessions every 5 minutes
    this.cleanupTimer = setInterval(
      async () => {
        await this.cleanupExpiredSessions();
      },
      5 * 60 * 1000,
    ); // 5 minutes
    this.cleanupTimer.unref();
  }

  /**
   * Clean up expired sessions based on session lifetime setting
   */
  private async cleanupExpiredSessions(): Promise<void> {
    try {
      const sessionLifetime = await configService.getSessionLifetime();

      // If session lifetime is null, sessions are infinite - skip cleanup
      if (sessionLifetime === null) {
        return;
      }

      const now = Date.now();
      const expiredSessionIds: string[] = [];

      // Find expired sessions
      for (const [sessionId, timestamp] of Object.entries(
        this.sessionTimestamps,
      )) {
        if (
          now - timestamp > sessionLifetime &&
          !this.inFlight.has(sessionId) &&
          !this.closing.has(sessionId)
        ) {
          expiredSessionIds.push(sessionId);
        }
      }

      // Clean up expired sessions
      if (expiredSessionIds.length > 0) {
        logger.info(
          `Cleaning up ${expiredSessionIds.length} idle MCP server pool sessions`,
        );

        await Promise.allSettled(
          expiredSessionIds.map((sessionId) => this.cleanupSession(sessionId)),
        );
      }
    } catch (error) {
      logger.error("Error during automatic session cleanup:", error);
    }
  }

  /**
   * Start the health check timer for idle sessions
   */
  private startHealthCheckTimer(): void {
    // Check idle session health every 60 seconds
    this.healthCheckTimer = setInterval(async () => {
      if (this.healthChecking || this.stopping) return;
      this.healthChecking = true;
      try {
        await this.checkIdleSessionHealth();
      } finally {
        this.healthChecking = false;
      }
    }, 60 * 1000); // 60 seconds
    this.healthCheckTimer.unref();
  }

  /**
   * Check health of idle sessions by pinging them.
   * Dead sessions are cleaned up and recreated.
   * Servers in ERROR state whose crash counters have been reset are retried.
   */
  private async checkIdleSessionHealth(): Promise<void> {
    const serverUuids = Object.keys(this.idleSessions);
    if (serverUuids.length === 0) {
      return;
    }

    for (const serverUuid of serverUuids) {
      const client = this.idleSessions[serverUuid];
      if (!client) continue;

      try {
        // Ping with a 5-second timeout
        await client.client.ping({ timeout: 5000 });
      } catch {
        logger.warn(
          `Idle session health check failed for server ${serverUuid}, recreating...`,
        );

        // It may have been borrowed while ping was pending.
        if (this.idleSessions[serverUuid] !== client) continue;
        delete this.idleSessions[serverUuid];
        // Clean up the dead session
        try {
          await client.cleanup();
        } catch {
          // Already dead, ignore cleanup errors
        }

        // Reset error state so we can retry
        await serverErrorTracker.resetServerErrorState(serverUuid);

        // Recreate if we have cached params
        const params = this.serverParamsCache[serverUuid];
        if (params) {
          this.createIdleSessionAsync(serverUuid, params);
        }
      }
    }

    // Also check for servers in ERROR state that have cached params but no idle session.
    // If they were reset (e.g., on startup), we should try to recreate them.
    for (const [serverUuid, params] of Object.entries(this.serverParamsCache)) {
      if (
        !this.idleSessions[serverUuid] &&
        !this.creatingIdleSessions.has(serverUuid)
      ) {
        const isError =
          await serverErrorTracker.isServerInErrorState(serverUuid);
        if (!isError) {
          // Not in error and no idle session - try to create one
          this.createIdleSessionAsync(serverUuid, params);
        }
      }
    }
  }

  /**
   * Get session age in milliseconds
   */
  getSessionAge(sessionId: string): number | undefined {
    const timestamp = this.sessionTimestamps[sessionId];
    return timestamp ? Date.now() - timestamp : undefined;
  }

  /**
   * Check if a session is expired
   */
  async isSessionExpired(sessionId: string): Promise<boolean> {
    const age = this.getSessionAge(sessionId);
    if (age === undefined) return false;

    const sessionLifetime = await configService.getSessionLifetime();
    if (sessionLifetime === null) return false; // infinite sessions
    return age > sessionLifetime;
  }
}

// Create a singleton instance
export const mcpServerPool = McpServerPool.getInstance();
