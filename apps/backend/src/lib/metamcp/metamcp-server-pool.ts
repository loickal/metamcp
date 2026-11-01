import { createHash } from "node:crypto";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import {
  clearAdminToolsContext,
  setAdminToolsContext,
} from "../admin-mcp/admin-session-context";
import { mcpServerPool } from "./mcp-server-pool";
import type { MetaMCPHandlerContext } from "./metamcp-middleware/functional-middleware";
import { createServer } from "./metamcp-proxy";

export interface AdminToolsOptions {
  enabled: boolean;
  userId: string;
}
export interface MetaMcpServerInstance {
  server: Server;
  cleanup: () => Promise<void>;
  internalSessionId: string;
}
export interface MetaMcpServerPoolStatus {
  idle: number;
  active: number;
  activeSessionIds: string[];
  idleNamespaceUuids: string[];
}

// SDK server handlers capture session ID and authorization context at creation.
// Such servers cannot be prewarmed under an idle ID and rebound to another user.
// Upstream connections retain their separate, bounded prewarming pool.
export class MetaMcpServerPool {
  private static instance: MetaMcpServerPool | null = null;
  private active = new Map<string, MetaMcpServerInstance>();
  private pending = new Map<
    string,
    Promise<MetaMcpServerInstance | undefined>
  >();
  private closing = new Map<string, Promise<void>>();
  private bindings = new Map<string, string>();
  private stopping = false;
  static getInstance(_defaultIdleCount = 1) {
    return (this.instance ??= new MetaMcpServerPool());
  }

  async getServer(
    id: string,
    namespace: string,
    includeInactive = false,
    headers?: Record<string, string>,
    admin?: AdminToolsOptions,
    context?: Pick<MetaMCPHandlerContext, "endpointName" | "auth">,
  ): Promise<MetaMcpServerInstance | undefined> {
    if (this.stopping || this.closing.has(id)) return undefined;
    const binding = createHash("sha256")
      .update(
        JSON.stringify([namespace, includeInactive, headers, admin, context]),
      )
      .digest("hex");
    if (this.bindings.has(id) && this.bindings.get(id) !== binding)
      throw new Error("MCP session context mismatch");
    if (this.active.has(id)) return this.active.get(id);
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.active.size + this.pending.size >= 1000) return undefined;
    this.bindings.set(id, binding);
    const pending = Promise.resolve()
      .then(async () => {
        const instance = await createServer(
          namespace,
          id,
          includeInactive,
          headers,
          context,
        );
        if (this.stopping || this.closing.has(id)) {
          await instance.server.close();
          await instance.cleanup();
          return undefined;
        }
        if (admin?.enabled && admin.userId) setAdminToolsContext(id, admin);
        this.active.set(id, instance);
        return instance;
      })
      .finally(() => {
        this.pending.delete(id);
        if (!this.active.has(id)) this.bindings.delete(id);
      });
    this.pending.set(id, pending);
    return pending;
  }
  cleanupSession(id: string): Promise<void> {
    const existing = this.closing.get(id);
    if (existing) return existing;
    const closing = Promise.resolve()
      .then(async () => {
        await this.pending.get(id)?.catch(() => {});
        const instance = this.active.get(id);
        this.active.delete(id);
        this.bindings.delete(id);
        clearAdminToolsContext(id);
        if (instance) {
          try {
            await instance.server.close();
          } finally {
            await instance.cleanup();
          }
        }
      })
      .finally(() => {
        this.closing.delete(id);
      });
    this.closing.set(id, closing);
    return closing;
  }
  async cleanupAll() {
    this.stopping = true;
    await Promise.allSettled(
      [...new Set([...this.active.keys(), ...this.pending.keys()])].map((id) =>
        this.cleanupSession(id),
      ),
    );
  }
  getPoolStatus(): MetaMcpServerPoolStatus {
    return {
      idle: 0,
      active: this.active.size,
      activeSessionIds: [...this.active.keys()],
      idleNamespaceUuids: [],
    };
  }
  getServerInstance(id: string) {
    return this.active.get(id);
  }
  getActiveSessionIds() {
    return [...this.active.keys()];
  }
  getMcpServerPoolStatus() {
    return mcpServerPool.getPoolStatus();
  }
  // Compatibility with namespace configuration hooks. Config is read afresh by
  // handlers; there is no namespace-only SDK server to invalidate or prewarm.
  async ensureIdleServers(_namespaces: string[], _includeInactive = false) {}
  async ensureIdleServerForNewNamespace(
    _namespace: string,
    _includeInactive = false,
  ) {}
  async invalidateIdleServer(_namespace: string, _includeInactive = false) {}
  async invalidateIdleServers(
    _namespaces: string[],
    _includeInactive = false,
  ) {}
  async cleanupIdleServer(namespace: string) {
    await this.cleanupSession(`openapi_${namespace}`);
  }
  async getOpenApiServer(namespace: string, includeInactive = false) {
    return this.getServer(`openapi_${namespace}`, namespace, includeInactive);
  }
  async invalidateOpenApiSessions(
    namespaces: string[],
    _includeInactive = false,
  ) {
    await Promise.all(
      namespaces.map((namespace) => this.cleanupIdleServer(namespace)),
    );
  }
}
export const metaMcpServerPool = MetaMcpServerPool.getInstance();
