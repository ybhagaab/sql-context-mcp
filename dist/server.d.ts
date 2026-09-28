/**
 * MCP server wiring: tool registration, server instructions, and protocol-version tracking.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Runtime } from './runtime';
export declare const SERVER_NAME = "sql-context-presets-mcp";
export declare const SERVER_VERSION = "1.5.0";
export declare const SERVER_INSTRUCTIONS: string;
export interface McpServerHandle {
    server: Server;
    connect(transport: Transport): Promise<void>;
    /** The negotiated protocol version, once the client has initialized. */
    protocolVersion(): string | null;
}
export declare function createMcpServer(runtime?: () => Runtime): McpServerHandle;
//# sourceMappingURL=server.d.ts.map