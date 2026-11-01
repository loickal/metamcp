import { TRPCError } from "@trpc/server";

import { mcpServersRepository } from "../../db/repositories";

export async function requireOAuthServer(serverId: string, userId: string) {
  if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });
  const server = await mcpServersRepository.findByUuid(serverId);
  if (!server || (server.user_id && server.user_id !== userId)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
  }
  if (!server.url || server.type === "STDIO") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "OAuth requires an HTTP MCP server",
    });
  }
  return { ...server, url: server.url };
}
