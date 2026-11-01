import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";

import logger from "@/utils/logger";

import { db } from "../../../db/index";
import {
  mcpServersTable,
  namespaceServerMappingsTable,
  namespaceToolMappingsTable,
  toolsTable,
} from "../../../db/schema";
import { parseToolName } from "../tool-name-parser";
import { sanitizeName } from "../utils";
import {
  CallToolMiddleware,
  ListToolsMiddleware,
} from "./functional-middleware";

/**
 * Configuration for the filter middleware
 */
export interface FilterToolsConfig {
  cacheEnabled?: boolean;
  cacheTTL?: number; // milliseconds
  customErrorMessage?: (toolName: string, reason: string) => string;
}

/**
 * Tool status cache for performance
 */
class ToolStatusCache {
  private cache = new Map<string, "ACTIVE" | "INACTIVE">();
  private expiry = new Map<string, number>();
  private ttl: number;

  constructor(ttl: number = 1000) {
    this.ttl = ttl;
  }

  private getCacheKey(
    namespaceUuid: string,
    toolName: string,
    serverUuid: string,
  ): string {
    return `${namespaceUuid}:${serverUuid}:${toolName}`;
  }

  get(
    namespaceUuid: string,
    toolName: string,
    serverUuid: string,
  ): "ACTIVE" | "INACTIVE" | null {
    const key = this.getCacheKey(namespaceUuid, toolName, serverUuid);
    const expiry = this.expiry.get(key);

    if (!expiry || Date.now() > expiry) {
      this.cache.delete(key);
      this.expiry.delete(key);
      return null;
    }

    return this.cache.get(key) || null;
  }

  set(
    namespaceUuid: string,
    toolName: string,
    serverUuid: string,
    status: "ACTIVE" | "INACTIVE",
  ): void {
    const key = this.getCacheKey(namespaceUuid, toolName, serverUuid);
    this.cache.set(key, status);
    this.expiry.set(key, Date.now() + this.ttl);
  }

  clear(namespaceUuid?: string): void {
    if (namespaceUuid) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${namespaceUuid}:`)) {
          this.cache.delete(key);
          this.expiry.delete(key);
        }
      }
    } else {
      this.cache.clear();
      this.expiry.clear();
    }
  }
}

// Global cache instance
const toolStatusCache = new ToolStatusCache();

/**
 * Get tool status from database with caching
 */
async function getToolStatus(
  namespaceUuid: string,
  toolName: string,
  serverUuid: string,
  useCache: boolean = true,
): Promise<"ACTIVE" | "INACTIVE" | null> {
  // Check cache first
  if (useCache) {
    const cached = toolStatusCache.get(namespaceUuid, toolName, serverUuid);
    if (cached !== null) {
      return cached;
    }
  }

  try {
    // Query database for tool status
    const [toolMapping] = await db
      .select({
        status: namespaceToolMappingsTable.status,
      })
      .from(namespaceToolMappingsTable)
      .innerJoin(
        toolsTable,
        eq(toolsTable.uuid, namespaceToolMappingsTable.tool_uuid),
      )
      .where(
        and(
          eq(namespaceToolMappingsTable.namespace_uuid, namespaceUuid),
          eq(toolsTable.name, toolName),
          eq(namespaceToolMappingsTable.mcp_server_uuid, serverUuid),
        ),
      );

    const status = toolMapping?.status || null;

    // Cache the result if found and caching is enabled
    if (status && useCache) {
      toolStatusCache.set(namespaceUuid, toolName, serverUuid, status);
    }

    return status;
  } catch (error) {
    logger.error(
      `Error fetching tool status for ${toolName} in namespace ${namespaceUuid}:`,
      error,
    );
    throw new Error("Tool permissions unavailable");
  }
}

// parseToolName is now imported from shared utility

/**
 * Get server UUID by name
 */
async function getServerUuidByName(
  serverName: string,
  namespaceUuid: string,
): Promise<string | null> {
  const servers = await db
    .select({ uuid: mcpServersTable.uuid, name: mcpServersTable.name })
    .from(mcpServersTable)
    .innerJoin(
      namespaceServerMappingsTable,
      eq(mcpServersTable.uuid, namespaceServerMappingsTable.mcp_server_uuid),
    )
    .where(eq(namespaceServerMappingsTable.namespace_uuid, namespaceUuid));
  const matches = servers.filter(
    (server) => sanitizeName(server.name) === serverName,
  );
  if (matches.length > 1) throw new Error("Ambiguous namespace tool prefix");
  return matches[0]?.uuid ?? null;
}

/**
 * Filter tools based on their status in the namespace
 */
async function filterActiveTools(
  tools: Tool[],
  namespaceUuid: string,
  useCache: boolean = true,
): Promise<Tool[]> {
  if (!tools || tools.length === 0) {
    return tools;
  }

  const filtered = await Promise.all(
    tools.map(async (tool) => {
      const parsed = parseToolName(tool.name);
      if (!parsed) throw new Error("Invalid namespace tool name");
      const serverUuid = await getServerUuidByName(
        parsed.serverName,
        namespaceUuid,
      );
      if (!serverUuid)
        throw new Error(
          "Namespace tool configuration changed; retry discovery",
        );
      const status = await getToolStatus(
        namespaceUuid,
        parsed.originalToolName,
        serverUuid,
        useCache,
      );
      return status === "INACTIVE" ? undefined : tool;
    }),
  );
  return filtered.filter((tool): tool is Tool => !!tool);
}

/**
 * Check if a tool is allowed to be called
 */
async function isToolAllowed(
  toolName: string,
  namespaceUuid: string,
  serverUuid: string,
  useCache: boolean = true,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const parsed = parseToolName(toolName);
    if (!parsed) {
      // If tool name doesn't follow expected format, allow it
      return { allowed: true };
    }

    const status = await getToolStatus(
      namespaceUuid,
      parsed.originalToolName,
      serverUuid,
      useCache,
    );

    // If no mapping exists or tool is active, allow it
    if (status === null || status === "ACTIVE") {
      return { allowed: true };
    }

    // Tool is inactive
    return {
      allowed: false,
      reason: "Tool has been marked as inactive in this namespace",
    };
  } catch (error) {
    logger.error(
      `Error checking if tool ${toolName} is allowed in namespace ${namespaceUuid}:`,
      error,
    );
    return { allowed: false, reason: "Tool permissions unavailable" };
  }
}

/**
 * Creates a List Tools middleware that filters out inactive tools
 */
export function createFilterListToolsMiddleware(
  config: FilterToolsConfig = {},
): ListToolsMiddleware {
  const useCache = config.cacheEnabled ?? true;

  return (handler) => {
    return async (request, context) => {
      // Call the original handler to get the tools
      const response = await handler(request, context);

      // Filter the tools based on namespace tool mappings
      if (response.tools) {
        const filteredTools = await filterActiveTools(
          response.tools,
          context.namespaceUuid,
          useCache,
        );

        return {
          ...response,
          tools: filteredTools,
        };
      }

      return response;
    };
  };
}

/**
 * Creates a Call Tool middleware that blocks calls to inactive tools
 */
export function createFilterCallToolMiddleware(
  config: FilterToolsConfig = {},
): CallToolMiddleware {
  const useCache = config.cacheEnabled ?? true;
  const customErrorMessage =
    config.customErrorMessage ??
    ((toolName: string, reason: string) =>
      `Tool "${toolName}" is currently inactive and disallowed in this namespace: ${reason}`);

  return (handler) => {
    return async (request, context) => {
      // Extract tool name and server info from the request
      const toolName = request.params.name;

      // We need to get serverUuid somehow - this would need to be passed through context
      // For now, let's extract it from the tool name format
      const parsed = parseToolName(toolName);
      if (parsed) {
        const serverUuid = await getServerUuidByName(
          parsed.serverName,
          context.namespaceUuid,
        );
        if (serverUuid) {
          const { allowed, reason } = await isToolAllowed(
            toolName,
            context.namespaceUuid,
            serverUuid,
            useCache,
          );

          if (!allowed) {
            // Return error response instead of calling the handler
            return {
              content: [
                {
                  type: "text",
                  text: customErrorMessage(
                    toolName,
                    reason || "Unknown reason",
                  ),
                },
              ],
              isError: true,
            };
          }
        }
      }

      // Tool is allowed, call the original handler
      return handler(request, context);
    };
  };
}

/**
 * Utility function to clear cache
 */
export function clearFilterCache(namespaceUuid?: string): void {
  toolStatusCache.clear(namespaceUuid);
}
