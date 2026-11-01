import {
  ListToolsResultSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { ConnectedClient } from "./client";

export async function listAllTools(
  session: ConnectedClient,
  meta?: Record<string, unknown>,
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await session.client.request(
      { method: "tools/list", params: { cursor, _meta: meta } },
      ListToolsResultSchema,
    );
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 1000))
      throw new Error("Invalid upstream tool pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}
