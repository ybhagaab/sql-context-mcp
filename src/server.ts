/**
 * MCP server wiring: tool registration, server instructions, and protocol-version tracking.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, handleToolCall } from './tools';
import { getRuntime, Runtime } from './runtime';
import { SERVER_NAME, SERVER_VERSION } from './version';

export { SERVER_NAME, SERVER_VERSION } from './version';

export const SERVER_INSTRUCTIONS =
  'Aggregate in SQL for analysis. run_query returns a page sized for model context, with the exact total; call fetch_rows ' +
  'with the resultId to continue. Use export_query for complete datasets; for long exports use wait: false and poll ' +
  'export_status. Session settings don\'t persist between calls, so put SET and the query in the same call.';

/** resource_link content items were added in MCP 2025-06-18. */
const RESOURCE_LINK_PROTOCOL = '2025-06-18';

export interface McpServerHandle {
  server: Server;
  connect(transport: Transport): Promise<void>;
  /** The negotiated protocol version, once the client has initialized. */
  protocolVersion(): string | null;
}

export function createMcpServer(runtime: () => Runtime = getRuntime): McpServerHandle {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  let negotiated: string | null = null;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await handleToolCall(request.params.name, request.params.arguments, extra, {
      runtime: runtime(),
      resourceLinks: negotiated !== null && negotiated >= RESOURCE_LINK_PROTOCOL,
    });
    return result as never;
  });

  return {
    server,
    async connect(transport: Transport): Promise<void> {
      await server.connect(transport);
      // The SDK doesn't expose the negotiated version, so compute it the same way from the
      // client's initialize request.
      const deliver = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if (isInitializeRequest(message)) {
          const requested = message.params.protocolVersion;
          negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        }
        deliver?.call(transport, message, extra);
      };
    },
    protocolVersion: () => negotiated,
  };
}
