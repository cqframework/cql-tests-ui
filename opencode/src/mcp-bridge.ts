// Author: Preston Lee

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MCPToolNames, OpenCodeFileToolNames } from '@cql-studio/core';
import type { OpenCodeWorkspaceManifest } from '@cql-studio/core';

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const baseUrl = process.env.CQL_STUDIO_OPENCODE_MCP_BRIDGE_URL?.replace(/\/+$/, '');
const capability = process.env.CQL_STUDIO_OPENCODE_MCP_CAPABILITY;
const workspace = process.env.CQL_STUDIO_OPENCODE_MCP_WORKSPACE;
const activeFile = process.env.CQL_STUDIO_OPENCODE_MCP_ACTIVE_FILE;
if (!baseUrl || !capability) {
  console.error('CQL Studio MCP bridge configuration is missing');
  process.exit(1);
}

async function bridgeRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${capability}`);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `CQL Studio MCP gateway returned HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

const server = new Server(
  { name: 'cql-studio', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await bridgeRequest<ToolDefinition[]>('/tools');
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      annotations: { readOnlyHint: !Object.values(OpenCodeFileToolNames).includes(tool.name), destructiveHint: false, openWorldHint: true },
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const argumentsForTool = { ...(request.params.arguments ?? {}) } as Record<string, unknown>;
    if (request.params.name === MCPToolNames.CQL_VALIDATE) {
      if (!workspace || !activeFile) throw new Error('CQL validation workspace configuration is missing');
      const manifestPath = path.join(workspace, '.cql-studio', 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as OpenCodeWorkspaceManifest;
      const requested = typeof argumentsForTool['file'] === 'string' ? argumentsForTool['file'] : Object.keys(manifest.files).find(file => manifest.files[file].libraryId === manifest.activeLibraryId) ?? activeFile;
      if (!manifest.files[requested]) throw new Error(`CQL file is not in this workspace: ${requested}`);
      argumentsForTool['__workspace'] = {
        activeFile: requested,
        files: await Promise.all(Object.entries(manifest.files).map(async ([file, entry]) => ({
          path: file,
          writable: entry.writable,
          content: await readFile(path.join(workspace, file), 'utf8'),
        }))),
      };
    }
    const result = await bridgeRequest<unknown>('/execute', {
      method: 'POST',
      body: JSON.stringify({ name: request.params.name, arguments: argumentsForTool }),
    });
    return {
      content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    };
  }
});

await server.connect(new StdioServerTransport());
