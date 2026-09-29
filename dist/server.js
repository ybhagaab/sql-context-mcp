"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERVER_INSTRUCTIONS = exports.SERVER_VERSION = exports.SERVER_NAME = void 0;
exports.createMcpServer = createMcpServer;
/**
 * MCP server wiring: tool registration, server instructions, and protocol-version tracking.
 */
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const tools_1 = require("./tools");
const runtime_1 = require("./runtime");
const version_1 = require("./version");
var version_2 = require("./version");
Object.defineProperty(exports, "SERVER_NAME", { enumerable: true, get: function () { return version_2.SERVER_NAME; } });
Object.defineProperty(exports, "SERVER_VERSION", { enumerable: true, get: function () { return version_2.SERVER_VERSION; } });
exports.SERVER_INSTRUCTIONS = 'Aggregate in SQL for analysis. run_query returns a page sized for model context, with the exact total; call fetch_rows ' +
    'with the resultId to continue. Use export_query for complete datasets; for long exports use wait: false and poll ' +
    'export_status. Session settings don\'t persist between calls, so put SET and the query in the same call. When a call ' +
    'fails, the error names the likely cause and the fix, and says whether any SQL ran; connection_status checks settings, ' +
    'DNS, network (VPN) and login step by step.';
/** resource_link content items were added in MCP 2025-06-18. */
const RESOURCE_LINK_PROTOCOL = '2025-06-18';
function createMcpServer(runtime = runtime_1.getRuntime) {
    const server = new index_js_1.Server({ name: version_1.SERVER_NAME, version: version_1.SERVER_VERSION }, { capabilities: { tools: {} }, instructions: exports.SERVER_INSTRUCTIONS });
    let negotiated = null;
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({ tools: tools_1.TOOLS }));
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request, extra) => {
        const result = await (0, tools_1.handleToolCall)(request.params.name, request.params.arguments, extra, {
            runtime: runtime(),
            resourceLinks: negotiated !== null && negotiated >= RESOURCE_LINK_PROTOCOL,
        });
        return result;
    });
    return {
        server,
        async connect(transport) {
            await server.connect(transport);
            // The SDK doesn't expose the negotiated version, so compute it the same way from the
            // client's initialize request.
            const deliver = transport.onmessage;
            transport.onmessage = (message, extra) => {
                if ((0, types_js_1.isInitializeRequest)(message)) {
                    const requested = message.params.protocolVersion;
                    negotiated = types_js_1.SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : types_js_1.LATEST_PROTOCOL_VERSION;
                }
                deliver?.call(transport, message, extra);
            };
        },
        protocolVersion: () => negotiated,
    };
}
