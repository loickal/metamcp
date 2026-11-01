import { findActualExecutable } from "spawn-rx";

import { mcpServersRepository } from "../../db/repositories";

// Associate saved Inspector configurations by UUID and user. Legacy callers
// without a UUID must match both the resolved executable AND its arguments;
// matching just "npx" can attribute a crash to an unrelated configured server.
export async function resolveStdioServerUuid(input: {
  command: string;
  args: string[];
  userId: string;
  serverUuid?: string;
}): Promise<string | null> {
  const configured = input.serverUuid
    ? [await mcpServersRepository.findByUuid(input.serverUuid)]
    : await mcpServersRepository.findAllAccessibleToUser(input.userId);
  if (
    input.serverUuid &&
    (!configured[0] ||
      (configured[0].user_id && configured[0].user_id !== input.userId))
  )
    throw new Error("MCP server not found");
  const actual = findActualExecutable(input.command, input.args);
  const matches = configured.filter((server) => {
    if (
      !server ||
      server.type !== "STDIO" ||
      !server.command ||
      (server.user_id && server.user_id !== input.userId)
    )
      return false;
    const saved = findActualExecutable(server.command, server.args ?? []);
    return (
      actual.cmd === saved.cmd &&
      JSON.stringify(actual.args) === JSON.stringify(saved.args)
    );
  });
  return matches.length === 1 ? (matches[0]?.uuid ?? null) : null;
}
