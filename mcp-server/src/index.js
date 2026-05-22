#!/usr/bin/env node
// =====================================================================
// HEXART.PL/AfterALL — MCP Server
// =====================================================================
// Exposes the After Effects AI agent over the Model Context Protocol
// so it can be driven from Claude Desktop, Claude Code, Antigravity,
// Cursor, or any other MCP-compatible client.
// =====================================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { BridgeClient } from './bridge.js';
import { tools as toolList } from './tools.js';

const PKG_NAME = '@hexart/afterall-mcp';
const PKG_VERSION = '2.2.0.3';

// CLI flag / env parsing
const argv = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
        const [k, v] = a.slice(2).split('=');
        if (v !== undefined) argMap[k] = v;
        else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { argMap[k] = argv[++i]; }
        else argMap[k] = true;
    }
}

const bridge = new BridgeClient({
    host: argMap.host || process.env.AFTERALL_HOST,
    port: argMap.port ? parseInt(argMap.port, 10) : undefined,
    token: argMap.token || process.env.AFTERALL_TOKEN,
    timeoutMs: argMap['timeout-ms'] ? parseInt(argMap['timeout-ms'], 10) : undefined
});

const server = new Server(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } }
);

// --- tools/list ------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: toolList.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
        }))
    };
});

// --- tools/call ------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = toolList.find(t => t.name === name);
    if (!tool) {
        return {
            isError: true,
            content: [{ type: 'text', text: 'Unknown tool: ' + name }]
        };
    }
    try {
        const result = await bridge.call(tool.bridgePath, args || {});
        // Build content based on returned shape
        const content = [];
        if (result && typeof result === 'object') {
            if (result.text) content.push({ type: 'text', text: String(result.text) });
            if (result.message && !result.text) content.push({ type: 'text', text: String(result.message) });
            if (Array.isArray(result.images)) {
                result.images.forEach(img => {
                    if (img && img.data && img.mimeType) {
                        content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
                    }
                });
            }
            // Always also include the raw JSON for programmatic clients
            content.push({ type: 'text', text: 'Result: ```json\n' + JSON.stringify(result, null, 2) + '\n```' });
        } else if (typeof result === 'string') {
            content.push({ type: 'text', text: result });
        } else {
            content.push({ type: 'text', text: 'OK' });
        }
        return { content };
    } catch (err) {
        return {
            isError: true,
            content: [{ type: 'text', text: 'Error: ' + (err && err.message ? err.message : String(err)) }]
        };
    }
});

// --- bootstrap -------------------------------------------------------
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // No console.log here — stdio is reserved for MCP traffic.
    // For debug logs use stderr only.
    process.stderr.write('[afterall-mcp] connected. Bridge target ' + bridge.host + ':' + bridge.port + (bridge.token ? ' (auth)' : ' (no auth)') + '\n');
}

main().catch((e) => {
    process.stderr.write('[afterall-mcp] fatal: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
