import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it, vi } from "vitest";
vi.mock("../utils/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import mcpProxy from "./mcp-proxy";
function fixture(): Transport {
  const transport: Transport = {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {
      transport.onclose?.();
    }),
  };
  return transport;
}
it("lets the session owner close transports once under reentrant close callbacks", async () => {
  const client = fixture();
  const server = fixture();
  const cleanup = vi.fn(async () => {
    await client.close();
    await server.close();
  });
  mcpProxy({
    transportToClient: client,
    transportToServer: server,
    onCleanup: cleanup,
  });
  client.onclose?.();
  server.onclose?.();
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  expect(server.close).toHaveBeenCalledOnce();
  expect(client.close).toHaveBeenCalledOnce();
});
