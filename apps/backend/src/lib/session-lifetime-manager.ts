import { configService } from "./config.service";
import { mcpEvent } from "./mcp-diagnostics";

export type SessionState = "INITIALIZING" | "ACTIVE" | "CLOSING" | "CLOSED";
type Entry<T> = {
  value: T;
  state: SessionState;
  createdAt: number;
  lastActivity: number;
  inFlight: number;
  drained?: () => void;
  closing?: Promise<void>;
};
const operations = new Map<string, <T>(fn: () => Promise<T>) => Promise<T>>();
const shutdowns = new Set<() => Promise<void>>();
// HTTP disconnect can precede completion of an RPC, especially on SSE.
export function withSessionActivity<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  return operations.get(id)?.(fn) ?? fn();
}
export async function shutdownMcpSessions() {
  await Promise.allSettled([...shutdowns].map((shutdown) => shutdown()));
}
export class SessionLifetimeManagerImpl<T> {
  private sessions = new Map<string, Entry<T>>();
  private cleanupTimer?: NodeJS.Timeout;
  private sweep?: Promise<void>;
  private shutdown?: () => Promise<void>;
  private stopping = false;
  constructor(
    private readonly name: string,
    private readonly maxSessions = 1000,
  ) {}
  addSession(
    id: string,
    value: T,
    state: "INITIALIZING" | "ACTIVE" = "ACTIVE",
  ) {
    if (
      this.stopping ||
      this.sessions.has(id) ||
      this.sessions.size >= this.maxSessions
    )
      throw new Error("MCP session capacity unavailable");
    const now = Date.now();
    this.sessions.set(id, {
      value,
      state,
      createdAt: now,
      lastActivity: now,
      inFlight: 0,
    });
    operations.set(id, (fn) => this.run(id, fn));
    mcpEvent("session_created", { transport: this.name, state }, id);
  }
  activate(id: string) {
    const entry = this.sessions.get(id);
    if (!entry || entry.state !== "INITIALIZING")
      throw new Error("Session initialization cancelled");
    entry.state = "ACTIVE";
    entry.lastActivity = Date.now();
    mcpEvent("session_initialized", { transport: this.name }, id);
  }
  getState(id: string): SessionState | undefined {
    return this.sessions.get(id)?.state;
  }
  getSession(id: string): T | undefined {
    const entry = this.sessions.get(id);
    if (entry?.state !== "ACTIVE") return undefined;
    entry.lastActivity = Date.now();
    return entry.value;
  }
  async run<R>(id: string, fn: () => Promise<R>): Promise<R> {
    const entry = this.sessions.get(id);
    if (!entry || entry.state === "CLOSING" || entry.state === "CLOSED")
      throw new Error("Session not found");
    entry.inFlight++;
    entry.lastActivity = Date.now();
    try {
      return await fn();
    } finally {
      entry.lastActivity = Date.now();
      entry.inFlight--;
      if (entry.inFlight === 0) entry.drained?.();
    }
  }
  close(
    id: string,
    cleanup: (id: string, value: T) => Promise<void>,
    reason = "explicit_delete",
  ): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    entry.state = "CLOSING";
    // Assign before invoking cleanup, since transport.close can reenter.
    entry.closing = Promise.resolve().then(async () => {
      if (entry.inFlight > 0)
        await new Promise<void>((resolve) => {
          entry.drained = resolve;
        });
      try {
        await cleanup(id, entry.value);
      } finally {
        entry.state = "CLOSED";
        this.removeSession(id);
        mcpEvent(
          "session_closed",
          {
            transport: this.name,
            reason,
            ageMs: Date.now() - entry.createdAt,
            idleMs: Date.now() - entry.lastActivity,
          },
          id,
        );
        mcpEvent(`cleanup_${reason}`);
      }
    });
    return entry.closing;
  }
  removeSession(id: string) {
    this.sessions.delete(id);
    operations.delete(id);
  }
  getAllSessions(): Map<string, T> {
    return new Map([...this.sessions].map(([id, entry]) => [id, entry.value]));
  }
  getSessionCount() {
    return this.sessions.size;
  }
  getSessionIds() {
    return [...this.sessions.keys()];
  }
  getSessionTimestamps() {
    return new Map(
      [...this.sessions].map(([id, entry]) => [id, entry.lastActivity]),
    );
  }
  getSessionAge(id: string) {
    const entry = this.sessions.get(id);
    return entry ? Date.now() - entry.createdAt : undefined;
  }
  private expired(entry: Entry<T> | undefined, lifetime: number | null) {
    return (
      !!entry &&
      entry.state === "ACTIVE" &&
      entry.inFlight === 0 &&
      lifetime !== null &&
      Date.now() - entry.lastActivity > lifetime
    );
  }
  async isSessionExpired(id: string) {
    return this.expired(
      this.sessions.get(id),
      await configService.getSessionLifetime(),
    );
  }
  cleanupExpiredSessions(
    cleanup: (id: string, value: T) => Promise<void>,
  ): Promise<void> {
    if (this.sweep) return this.sweep;
    this.sweep = (async () => {
      const lifetime = await configService.getSessionLifetime();
      const pending = [];
      for (const [id, entry] of this.sessions) {
        // No await between checking activity and transitioning to CLOSING.
        if (this.expired(entry, lifetime))
          pending.push(this.close(id, cleanup, "idle_timeout"));
      }
      await Promise.allSettled(pending);
    })().finally(() => {
      this.sweep = undefined;
    });
    return this.sweep;
  }
  startCleanupTimer(
    cleanup: (id: string, value: T) => Promise<void>,
    intervalMs = 60_000,
  ) {
    this.stopCleanupTimer();
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions(cleanup).catch(() =>
        mcpEvent("session_sweep_failed"),
      );
    }, intervalMs);
    this.cleanupTimer.unref();
    this.shutdown = async () => {
      this.stopping = true;
      this.stopCleanupTimer();
      await Promise.allSettled(
        [...this.sessions.keys()].map((id) =>
          this.close(id, cleanup, "shutdown"),
        ),
      );
    };
    shutdowns.add(this.shutdown);
  }
  stopCleanupTimer() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    if (this.shutdown) shutdowns.delete(this.shutdown);
  }
}
