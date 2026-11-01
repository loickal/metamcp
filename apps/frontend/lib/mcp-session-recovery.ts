// Reinitialize without the old Mcp-Session-Id after a protocol 404. Only safe
// metadata requests are replayed; tool execution is never retried here.
export function isMcpSessionMiss(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: number; status?: number; message?: string };
  return (
    value.code === 404 ||
    value.status === 404 ||
    /(?:HTTP|status|code)[^\d]*404\b/i.test(value.message ?? "")
  );
}
const safeMethods = new Set([
  "ping",
  "tools/list",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "completion/complete",
]);
export async function requestWithMcpSessionRecovery<T>(
  method: string,
  attempt: () => Promise<T>,
  reconnect: () => Promise<void>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isMcpSessionMiss(error)) throw error;
    await reconnect();
    if (!safeMethods.has(method))
      throw new Error(
        "MCP session was replaced. The request was not replayed; check its outcome before retrying.",
      );
    return attempt();
  }
}
