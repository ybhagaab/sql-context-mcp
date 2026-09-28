import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Runtime } from './runtime';
export declare const TOOLS: Tool[];
export interface ToolExtra {
    signal?: AbortSignal;
    _meta?: {
        progressToken?: string | number;
    };
    sendNotification?: (notification: {
        method: 'notifications/progress';
        params: Record<string, unknown>;
    }) => Promise<void>;
}
export interface ToolContext {
    runtime: Runtime;
    /** The client negotiated MCP 2025-06-18 or later, so it understands resource_link content. */
    resourceLinks: boolean;
}
type Content = {
    type: 'text';
    text: string;
} | {
    type: 'resource_link';
    uri: string;
    name: string;
    mimeType?: string;
    description?: string;
};
export interface ToolResult {
    content: Content[];
    isError?: boolean;
    [key: string]: unknown;
}
export declare function handleToolCall(name: string, args: unknown, extra: ToolExtra, ctx: ToolContext): Promise<ToolResult>;
export {};
//# sourceMappingURL=tools.d.ts.map