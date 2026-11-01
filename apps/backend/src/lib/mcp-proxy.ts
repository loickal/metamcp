import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";

import logger from "@/utils/logger";

function onClientError(error: Error) {
  // Don't log "Not connected" errors as they're expected when connections close
  if (error?.message && error.message.includes("Not connected")) {
    logger.debug("Client transport disconnected (expected during cleanup)");
    return;
  }
  logger.error("Error from inspector client:", error);
}

function onServerError(error: Error) {
  // Don't log "Not connected" errors as they're expected when connections close
  if (error?.message && error.message.includes("Not connected")) {
    logger.debug("Server transport disconnected (expected during cleanup)");
    return;
  }

  if (
    (error?.message &&
      error.message.includes("Error POSTing to endpoint (HTTP 404)")) ||
    (error?.cause && JSON.stringify(error.cause).includes("ECONNREFUSED"))
  ) {
    logger.error("Connection refused. Is the MCP server running?");
  } else {
    logger.error("Error from MCP server:", error);
  }
}

export default function mcpProxy({
  transportToClient,
  transportToServer,
  onCleanup,
}: {
  transportToClient: Transport;
  transportToServer: Transport;
  onCleanup?: () => Promise<void> | void;
}) {
  let transportToClientClosed = false;
  let transportToServerClosed = false;
  let closing: Promise<void> | undefined;
  // The session owner closes transports when supplied. Closing them here too
  // reenters onclose -> route cleanup and sends duplicate process signals.
  const closeAllTransports = (): Promise<void> => {
    if (closing) return closing;
    transportToClientClosed = true;
    transportToServerClosed = true;
    closing = Promise.resolve()
      .then(async () => {
        if (onCleanup) await onCleanup();
        else
          await Promise.allSettled([
            transportToClient.close(),
            transportToServer.close(),
          ]);
      })
      .catch(() => logger.error("MCP proxy cleanup failed"));
    return closing;
  };

  transportToClient.onmessage = (message) => {
    // Check if server transport is still connected before sending
    if (transportToServerClosed) {
      logger.debug("Ignoring message to closed server transport");
      return;
    }

    transportToServer.send(message).catch(async (error) => {
      // Handle connection closed errors gracefully
      if (error?.message && error.message.includes("Not connected")) {
        logger.debug(
          "Server transport disconnected while sending message, cleaning up",
        );
        await closeAllTransports();
        return;
      }

      // Send error response back to client if it was a request (has id) and connection is still open
      if (isJSONRPCRequest(message) && !transportToClientClosed) {
        const errorResponse = {
          jsonrpc: "2.0" as const,
          id: message.id,
          error: {
            code: -32001,
            message: error.message,
            data: error,
          },
        };

        // Safely send error response
        if (!transportToClientClosed) {
          transportToClient.send(errorResponse).catch(onClientError);
        }
      }
    });
  };

  transportToServer.onmessage = (message) => {
    // Check if client transport is still connected before sending
    if (transportToClientClosed) {
      logger.debug("Ignoring message to closed client transport");
      return;
    }

    transportToClient.send(message).catch(async (error) => {
      // Handle connection closed errors gracefully
      if (error?.message && error.message.includes("Not connected")) {
        logger.debug(
          "Client transport disconnected while sending message, cleaning up",
        );
        await closeAllTransports();
        return;
      }
      onClientError(error);
    });
  };

  const clientOnClose = transportToClient.onclose;
  const serverOnClose = transportToServer.onclose;
  transportToClient.onclose = () => {
    clientOnClose?.();
    void closeAllTransports();
  };
  transportToServer.onclose = () => {
    serverOnClose?.();
    void closeAllTransports();
  };

  transportToClient.onerror = async (error) => {
    // Mark as closed and trigger cleanup if we get a connection error
    if (error?.message && error.message.includes("Not connected")) {
      logger.debug("Client transport error: Not connected, cleaning up");
      await closeAllTransports();
      return;
    }
    onClientError(error);
  };

  transportToServer.onerror = async (error) => {
    // Mark as closed and trigger cleanup if we get a connection error
    if (error?.message && error.message.includes("Not connected")) {
      logger.debug("Server transport error: Not connected, cleaning up");
      await closeAllTransports();
      return;
    }
    onServerError(error);
  };
}
