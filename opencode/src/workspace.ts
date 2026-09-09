// Author: Preston Lee

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import { MCPToolNames, OpenCodeFileToolNames, OpenCodeError } from '@cql-studio/core';
import type {
  CreateOpenCodeSessionRequest,
  OpenCodeAttachmentDto,
  OpenCodeAttachmentUploadRequest,
  OpenCodeProviderConfig,
  OpenCodeFileDiffDto,
  OpenCodeWorkspaceManifest,
  OpenCodeLibraryInput,
  OpenCodeFileOperation,
} from '@cql-studio/core';

const execFileAsync = promisify(execFile);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_CONVERTED_BYTES = 4 * 1024 * 1024;
const MARKITDOWN_BIN = 'markitdown';
const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.xml',
  '.yaml', '.yml', '.html', '.htm', '.css', '.scss', '.js', '.jsx', '.ts', '.tsx', '.py',
  '.java', '.go', '.rs', '.sql', '.log', '.ini', '.toml', '.sh', '.bash', '.bat', '.ps1',
  '.graphql', '.gql', '.ttl', '.rdf', '.cql', '.rtf', '.tex', '.rst', '.adoc', '.conf', '.cfg',
  '.env', '.properties', '.dockerfile', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.kt',
  '.swift', '.rb', '.php', '.pl', '.vim', '.xhtml',
]);
const MARKITDOWN_EXTENSIONS = new Set(['.pdf', '.docx']);
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.mp3', '.wav', '.mp4',
  '.mov', '.avi', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods',
]);

export function mcpBridgeExecutable(
  moduleUrl = import.meta.url,
  configured = process.env.CQL_STUDIO_OPENCODE_MCP_BRIDGE_BIN
): string {
  return configured?.trim() || fileURLToPath(new URL('./mcp-bridge.js', moduleUrl));
}

export function resolveExecutableOnPath(
  bin: string,
  pathEnv: string = process.env.PATH ?? ''
): string | undefined {
  const trimmed = bin.trim();
  if (!trimmed) return undefined;
  if (path.isAbsolute(trimmed)) {
    try {
      accessSync(trimmed, constants.X_OK);
      return trimmed;
    } catch {
      return undefined;
    }
  }
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    try {
      accessSync(path.join(directory, trimmed), constants.X_OK);
      return path.join(directory, trimmed);
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

export interface OpenCodeWorkspaceOptions {
  rewriteLocalhost?: boolean;
  mcpBridgeBin?: string;
  markitdownBin?: string;
}

export interface MaterializedWorkspace {
  id: string;
  directory: string;
  activeFile: string;
  manifest: OpenCodeWorkspaceManifest;
  baselineByFile: Map<string, string>;
}

export interface OpenCodeAttachmentInput extends OpenCodeAttachmentUploadRequest {}

function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);
  return normalized || fallback;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function countChangedLines(before: string, after: string): { additions: number; deletions: number } {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    deletions: Math.max(0, beforeLines.length - prefix - suffix),
    additions: Math.max(0, afterLines.length - prefix - suffix),
  };
}

function normalizeOllamaBaseUrl(raw: string, rewriteLocalhost: boolean): string {
  const url = new URL(raw);
  if (
    rewriteLocalhost &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    url.hostname = 'host.docker.internal';
  }
  const withoutSlash = url.toString().replace(/\/+$/, '');
  return withoutSlash.endsWith('/v1') ? withoutSlash : `${withoutSlash}/v1`;
}

function normalizeProviderBaseUrl(raw: string, appendV1 = true): string {
  const url = new URL(raw);
  const withoutSlash = url.toString().replace(/\/+$/, '');
  return appendV1 && !withoutSlash.endsWith('/v1') ? `${withoutSlash}/v1` : withoutSlash;
}

export function providerFor(input: CreateOpenCodeSessionRequest): OpenCodeProviderConfig {
  if (input.provider) return input.provider;
  return { type: 'ollama', model: input.ollamaModel, baseUrl: input.ollamaBaseUrl };
}

export function providerIdFor(provider: OpenCodeProviderConfig): string {
  if (provider.type === 'ollama') return 'ollama';
  if (provider.type === 'openai') return 'openai';
  const id = (provider.name || 'custom')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48);
  return id || 'custom';
}

export class OpenCodeWorkspaceManager {
  private readonly root: string;
  private readonly rewriteLocalhost: boolean;
  private readonly mcpBridgeBin?: string;
  private readonly markitdownBin?: string;

  constructor(
    root = process.env.CQL_STUDIO_OPENCODE_WORKSPACE_ROOT || './workspaces',
    options: OpenCodeWorkspaceOptions = {}
  ) {
    this.root = path.resolve(root);
    this.rewriteLocalhost = options.rewriteLocalhost
      ?? process.env.CQL_STUDIO_OPENCODE_RUNNER_REWRITE_LOCALHOST === 'true';
    this.mcpBridgeBin = options.mcpBridgeBin?.trim() || undefined;
    const configuredMarkitdown = options.markitdownBin?.trim()
      || process.env.CQL_STUDIO_OPENCODE_MARKITDOWN_BIN?.trim()
      || MARKITDOWN_BIN;
    this.markitdownBin = resolveExecutableOnPath(configuredMarkitdown);
  }

  markitdownAvailable(): boolean {
    return Boolean(this.markitdownBin);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Runtime sessions are intentionally ephemeral. Anything left at runner startup
    // cannot have a live owning session and is therefore an orphan.
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const orphan = path.join(this.root, entry.name);
      await chmod(path.join(orphan, 'dependencies'), 0o700).catch(() => undefined);
      await chmod(path.join(orphan, 'libraries'), 0o700).catch(() => undefined);
      await rm(orphan, { recursive: true, force: true });
    }
  }

  async create(input: CreateOpenCodeSessionRequest): Promise<MaterializedWorkspace> {
    if (input.libraries && (!Array.isArray(input.libraries) || input.libraries.length > 100)) throw new Error('Provide up to 100 CQL libraries');
    const requestedId = input.resume?.sessionId;
    const id = requestedId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId)
      ? requestedId
      : randomUUID();
    const directory = path.join(this.root, id);
    if (requestedId) await rm(directory, { recursive: true, force: true });
    const librariesDirectory = path.join(directory, 'libraries');
    const dependenciesDirectory = path.join(directory, 'dependencies');
    const metadataDirectory = path.join(directory, '.cql-studio');
    const commandsDirectory = path.join(directory, '.opencode', 'commands');
    const validateVsacSkillDirectory = path.join(directory, '.opencode', 'skills', 'validate-vsac');
    const attachmentsDirectory = path.join(directory, 'attachments');
    await mkdir(librariesDirectory, { recursive: true, mode: 0o700 });
    // Populate first, then remove directory write permission once all dependencies exist.
    await mkdir(dependenciesDirectory, { recursive: true, mode: 0o700 });
    await mkdir(metadataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(commandsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(validateVsacSkillDirectory, { recursive: true, mode: 0o700 });
    await mkdir(attachmentsDirectory, { recursive: true, mode: 0o700 });

    const usedNames = new Set<string>();
    const uniqueFile = (name: string, fallback: string): string => {
      const base = safeSegment(name, fallback).replace(/\.cql$/i, '');
      let candidate = `${base}.cql`;
      let index = 2;
      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${base}-${index++}.cql`;
      }
      usedNames.add(candidate.toLowerCase());
      return candidate;
    };

    const activeName = uniqueFile(input.activeLibrary.name, input.activeLibrary.id);
    const activeFile = `libraries/${activeName}`;
    await writeFile(path.join(directory, activeFile), input.activeLibrary.cqlContent, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // Native tools may edit managed files; structural changes use the approved file tools.
    await chmod(librariesDirectory, 0o500);

    const manifest: OpenCodeWorkspaceManifest = {
      schemaVersion: 1,
      sessionId: id,
      createdAt: new Date().toISOString(),
      activeLibraryId: input.activeLibrary.id,
      files: {
        [activeFile]: {
          libraryId: input.activeLibrary.id,
          name: input.activeLibrary.name,
          version: input.activeLibrary.version,
          canonicalUrl: input.activeLibrary.canonicalUrl,
          fhirVersionId: input.activeLibrary.fhirVersionId,
          workspaceOrigin: input.activeLibrary.workspaceOrigin,
          sourceHash: sha256(input.activeLibrary.originalContent ?? input.activeLibrary.cqlContent),
          draft: (input.activeLibrary.originalContent ?? input.activeLibrary.cqlContent) !== input.activeLibrary.cqlContent,
          writable: true,
        },
      },
    };

    for (const dependency of input.dependencies ?? []) {
      if (!dependency.cqlContent.trim() || [input.activeLibrary, ...(input.libraries ?? [])].some(library => library.id === dependency.id)) continue;
      const dependencyName = uniqueFile(dependency.name, dependency.id);
      const relativeFile = `dependencies/${dependencyName}`;
      const absoluteFile = path.join(directory, relativeFile);
      await writeFile(absoluteFile, dependency.cqlContent, { encoding: 'utf8', mode: 0o400 });
      manifest.files[relativeFile] = {
        libraryId: dependency.id,
        name: dependency.name,
        version: dependency.version,
        canonicalUrl: dependency.canonicalUrl,
        fhirVersionId: dependency.fhirVersionId,
        sourceHash: sha256(dependency.originalContent ?? dependency.cqlContent),
        draft: false,
        writable: false,
      };
    }
    await chmod(dependenciesDirectory, 0o500);

    const agentInstructions = [
      '# CQL Studio OpenCode workspace',
      '',
      `The main CQL library is \`${activeFile}\`. All managed files in libraries/ are writable; choose the corresponding file(s) for the user request.`,
      'Files in `dependencies/` are reference-only and must not be edited.',
      `Use ${OpenCodeFileToolNames.CREATE} to create CQL libraries and ${OpenCodeFileToolNames.RENAME} to rename them. These tools save to the user library and wait for approval. Never create, rename, or delete files using other tools.`,
      'Preserve the CQL library name and version unless the user explicitly asks to change them.',
      `When repairing CQL, treat the current CQL Studio Problems context as the initial diagnostic set and then run ${MCPToolNames.CQL_VALIDATE} for each edited file.`,
      'Before adding or changing a FHIR conversion helper call, read `dependencies/FHIRHelpers.cql` and use only a function declared there. Preserve the active library\'s existing FHIRHelpers alias, or add the 4.0.1 include when needed.',
      'Never invent ValueSet, CodeSystem, or VSAC canonical URLs.',
      'Do not access paths outside this workspace and do not run destructive commands.',
      'CQL Studio will validate and review every file diff before saving it to FHIR.',
      '',
    ].join('\n');
    await writeFile(path.join(directory, 'AGENTS.md'), agentInstructions, { encoding: 'utf8', mode: 0o400 });

    const commands: Record<string, { description: string; template: string }> = {
      validate: {
        description: 'Validate active CQL without editing',
        template: `Validate @${activeFile} with ${MCPToolNames.CQL_VALIDATE}. Report errors and warnings with locations. Do not edit unless explicitly asked.`,
      },
      review: {
        description: 'Validate and review active CQL',
        template: `First validate @${activeFile} with ${MCPToolNames.CQL_VALIDATE}. Then review it for CQL correctness, clinical intent, dependency usage, terminology accuracy, and maintainability. Use the other read-only MCP tools when external context is needed. Do not edit unless explicitly asked.`,
      },
      explain: {
        description: 'Explain active CQL with an optional focus',
        template: `Explain the requested CQL in @${activeFile} for a CQL author. Focus on: $ARGUMENTS`,
      },
      dependencies: {
        description: 'Inspect includes and resolve dependency problems',
        template: `Inspect @${activeFile} and the dependency files, then run ${MCPToolNames.CQL_VALIDATE}. Explain every include, missing or conflicting version, and dependency-related diagnostic. For an unresolved Library include, use ${MCPToolNames.CQL_LIBRARY_SEARCH} and ${MCPToolNames.CQL_LIBRARY_READ} against the configured read-only endpoints. Do not edit or save FHIR resources.`,
      },
      library: {
        description: 'Research read-only FHIR Library resources',
        template: `Use ${MCPToolNames.CQL_LIBRARY_SEARCH} and ${MCPToolNames.CQL_LIBRARY_READ} to research this Library request without modifying FHIR: $ARGUMENTS`,
      },
      valueset: {
        description: 'Research an authoritative VSAC ValueSet',
        template: `Use ${MCPToolNames.VSAC_SEARCH} for ValueSet discovery, ${MCPToolNames.VALIDATE_VSAC} only for an exact URL or OID supplied by the user or existing CQL, and ${MCPToolNames.VALUESET_EXPAND} when concepts must be inspected. Never guess an identifier or canonical URL: $ARGUMENTS`,
      },
      context: {
        description: 'Show active CQL Studio endpoints and capabilities',
        template: `Use ${MCPToolNames.CQL_STUDIO_CONTEXT} to summarize the active CQL Studio environment, configured endpoint roles, and available read-only capabilities. Never expose credentials or headers.`,
      },
      fhir: {
        description: 'Read or search the configured FHIR environment',
        template: `Use ${MCPToolNames.CQL_STUDIO_CONTEXT} when endpoint selection is unclear, then use ${MCPToolNames.FHIR_READ} or ${MCPToolNames.FHIR_SEARCH} to answer this request from the configured FHIR environment. Keep searches bounded, return only relevant fields, and do not modify any resource: $ARGUMENTS`,
      },
      research: {
        description: 'Research a topic with web search and safe fetching',
        template: `Research this request with ${MCPToolNames.SEARXNG_SEARCH} and the hardened fetch tools. Prefer the smallest useful number of calls, distinguish source evidence from inference, and include the source URLs in the answer: $ARGUMENTS`,
      },
      terminology: {
        description: 'Research ValueSets, CodeSystems, and expansions',
        template: `Research this terminology request using the configured read-only tools. Use ${MCPToolNames.VSAC_SEARCH} for VSAC discovery, ${MCPToolNames.VALIDATE_VSAC} only for an exact user-supplied or existing reference, ${MCPToolNames.VALUESET_EXPAND} for concepts, and ${MCPToolNames.FHIR_READ} or ${MCPToolNames.FHIR_SEARCH} for other configured terminology resources. Never guess a canonical URL or identifier: $ARGUMENTS`,
      },
      'validate-vsac': {
        description: 'Validate VSAC references in active CQL or an exact URL/OID',
        template: `Load the validate-vsac skill. Validate $ARGUMENTS when it contains an exact VSAC canonical URL or OID. When no argument is supplied, inspect @${activeFile} and validate every declared VSAC ValueSet reference. Report whether each reference is authoritative in VSAC and whether it is present on the configured terminology endpoint. Do not write any FHIR resource.`,
      },
    };
    await Promise.all(Object.entries(commands).map(([name, command]) =>
      writeFile(
        path.join(commandsDirectory, `${name}.md`),
        `---\ndescription: ${command.description}\n---\n${command.template}\n`,
        { encoding: 'utf8', mode: 0o400 }
      )
    ));

    const validateVsacSkill = [
      '---',
      'name: validate-vsac',
      'description: Validate exact VSAC ValueSet URLs or OIDs, and audit VSAC ValueSet declarations in the active CQL Library without guessing identifiers or modifying FHIR.',
      'compatibility: opencode',
      '---',
      '',
      '# Validate VSAC terminology',
      '',
      `1. Read \`${activeFile}\` when no exact reference was supplied.`,
      `2. For an exact canonical URL or OID supplied by the user or declared in CQL, call \`${MCPToolNames.VALIDATE_VSAC}\`.`,
      `3. If only a clinical name or topic is known, use \`${MCPToolNames.VSAC_SEARCH}\` for discovery instead of guessing an identifier.`,
      `4. Use \`${MCPToolNames.FHIR_SEARCH}\` with the terminology role and an exact canonical URL to determine whether a verified ValueSet is already present on the configured terminology server.`,
      `5. Use \`${MCPToolNames.VALUESET_EXPAND}\` only when the user asks to inspect concepts or confirm that the configured terminology server can expand an already-present ValueSet.`,
      '6. Report verified URL, id/OID, version, VSAC status, terminology-server presence, and any validation error.',
      '',
      'This skill is read-only. Never call a write endpoint, never invent or normalize a canonical URL, and never treat a general web search result as authoritative VSAC evidence.',
      '',
    ].join('\n');
    await writeFile(
      path.join(validateVsacSkillDirectory, 'SKILL.md'),
      validateVsacSkill,
      { encoding: 'utf8', mode: 0o400 }
    );

    const provider = providerFor(input);
    const providerId = providerIdFor(provider);
    const modelId = provider.model || input.ollamaModel;
    const configuredProviders = [provider, ...(input.providers ?? [])]
      .filter((candidate, index, all) => all.findIndex(item => providerIdFor(item) === providerIdFor(candidate)) === index);
    const providerConfigs = Object.fromEntries(configuredProviders.map(candidate => {
      const candidateId = providerIdFor(candidate);
      const candidateBaseUrl = candidate.type === 'ollama'
        ? normalizeOllamaBaseUrl(candidate.baseUrl || input.ollamaBaseUrl, this.rewriteLocalhost)
        : normalizeProviderBaseUrl(candidate.baseUrl || 'https://api.openai.com/v1');
      const candidateOptions: Record<string, unknown> = { baseURL: candidateBaseUrl };
      // The documented provider configuration path for API-key authentication.
      if (candidate.apiKey?.trim()) candidateOptions.apiKey = candidate.apiKey.trim();
      const candidateModel = candidate.model || modelId;
      return [candidateId, {
        npm: candidate.type === 'openai' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible',
        name: candidate.name || (candidate.type === 'ollama' ? 'Ollama (local)' : 'OpenAI'),
        options: candidateOptions,
        models: {
          [candidateModel]: {
            name: candidateModel,
            options: { reasoningEffort: 'none' },
            variants: {
              fast: { reasoningEffort: 'none' },
              thinking: { reasoningEffort: 'medium' },
            },
          },
        },
      }];
    }));
    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      model: `${providerId}/${modelId}`,
      small_model: `${providerId}/${modelId}`,
      instructions: ['AGENTS.md'],
      permission: {
        // OpenCode 1.18.x currently hides native edit/write tools when a granular
        // catch-all deny is present, then applies that deny before a file-specific
        // allow at call time. Filesystem modes are the authoritative boundary:
        // the active file is 0600; dependencies, config, manifest, commands, and
        // instructions are 0400. MCP tools remain read-only.
        edit: 'allow',
        bash: 'deny',
        webfetch: 'deny',
        external_directory: 'deny',
        doom_loop: 'ask',
        skill: { '*': 'allow' },
      },
      provider: providerConfigs,
      ...(input.toolBridge ? {
        mcp: {
          'cql-studio': {
            type: 'local',
            command: [process.execPath, mcpBridgeExecutable(import.meta.url, this.mcpBridgeBin)],
            environment: {
              CQL_STUDIO_OPENCODE_MCP_BRIDGE_URL: input.toolBridge.baseUrl,
              CQL_STUDIO_OPENCODE_MCP_CAPABILITY: input.toolBridge.capability,
              CQL_STUDIO_OPENCODE_MCP_WORKSPACE: directory,
              CQL_STUDIO_OPENCODE_MCP_ACTIVE_FILE: activeFile,
            },
            enabled: true,
            timeout: 60 * 60 * 1000,
          },
        },
      } : {}),
    };
    await writeFile(path.join(directory, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2), {
      encoding: 'utf8',
      mode: 0o400,
    });
    await writeFile(path.join(metadataDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      encoding: 'utf8',
      mode: 0o400,
    });

    const workspace = { id, directory, activeFile, manifest,
      baselineByFile: new Map([[activeFile, input.activeLibrary.cqlContent]]) };
    for (const library of input.libraries ?? []) await this.addLibrary(workspace, library);
    return workspace;
  }

  fileForLibrary(workspace: MaterializedWorkspace, libraryId: string): string {
    const file = Object.keys(workspace.manifest.files).find(file => workspace.manifest.files[file].libraryId === libraryId);
    if (!file) throw new Error(`Library is not in this workspace: ${libraryId}`);
    return file;
  }

  private async saveManifest(workspace: MaterializedWorkspace): Promise<void> {
    const file = path.join(workspace.directory, '.cql-studio/manifest.json');
    await chmod(file, 0o600);
    try { await writeFile(file, JSON.stringify(workspace.manifest, null, 2)); }
    finally { await chmod(file, 0o400); }
  }

  async addLibrary(workspace: MaterializedWorkspace, library: OpenCodeLibraryInput): Promise<void> {
    if (!library || typeof library.id !== 'string' || !library.id || typeof library.name !== 'string' || typeof library.cqlContent !== 'string' || Buffer.byteLength(library.cqlContent) > 1_048_576) throw new Error('Invalid CQL library');
    if (Object.values(workspace.manifest.files).some(entry => entry.libraryId === library.id && entry.writable)) return;
    const name = safeSegment(library.name, library.id).replace(/\.cql$/i, '');
    let file = `libraries/${name}.cql`;
    for (let i = 2; Object.keys(workspace.manifest.files).some(item => item.toLowerCase() === file.toLowerCase()); i++) file = `libraries/${name}-${i}.cql`;
    await chmod(path.join(workspace.directory, 'libraries'), 0o700);
    try { await writeFile(path.join(workspace.directory, file), library.cqlContent, { flag: 'wx', mode: 0o600 }); }
    finally { await chmod(path.join(workspace.directory, 'libraries'), 0o500); }
    // Promote a previously reference-only dependency when opened in the IDE.
    for (const [oldFile, entry] of Object.entries(workspace.manifest.files)) {
      if (entry.libraryId !== library.id) continue;
      await chmod(path.join(workspace.directory, 'dependencies'), 0o700);
      try { await rm(path.join(workspace.directory, oldFile)); }
      finally { await chmod(path.join(workspace.directory, 'dependencies'), 0o500); }
      delete workspace.manifest.files[oldFile];
    }
    workspace.manifest.files[file] = { libraryId: library.id, name: library.name, version: library.version,
      canonicalUrl: library.canonicalUrl, fhirVersionId: library.fhirVersionId, workspaceOrigin: library.workspaceOrigin,
      sourceHash: sha256(library.cqlContent), draft: false, writable: true };
    workspace.baselineByFile.set(file, library.cqlContent);
    await this.saveManifest(workspace);
  }

  prepareOperation(workspace: MaterializedWorkspace, kind: 'create' | 'rename', input: Record<string, unknown>): OpenCodeFileOperation {
    if (typeof input['name'] !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(input['name'])) throw new Error('Use a valid CQL library name (letters, digits, underscores)');
    if (typeof input['content'] !== 'string' || !input['content'].trim() || Buffer.byteLength(input['content']) > 1_048_576) throw new Error('Provide CQL content up to 1 MiB');
    const name = input['name'];
    const file = `libraries/${name}.cql`;
    if (Object.keys(workspace.manifest.files).some(candidate => candidate.toLowerCase() === file.toLowerCase())) throw new Error('A file with that name already exists');
    const previousFile = kind === 'rename' && typeof input['file'] === 'string' ? input['file'] : undefined;
    if (kind === 'rename' && (!previousFile || !workspace.manifest.files[previousFile]?.writable)) throw new Error('Rename requires a writable workspace file');
    return { kind, name, file, content: input['content'], libraryId: previousFile ? workspace.manifest.files[previousFile].libraryId : randomUUID(), previousFile };
  }

  async completeOperation(workspace: MaterializedWorkspace, operation: OpenCodeFileOperation): Promise<void> {
    if (operation.kind === 'create') {
      await this.addLibrary(workspace, { id: operation.libraryId, name: operation.name, cqlContent: operation.content });
      return;
    }
    const previous = operation.previousFile!;
    const entry = workspace.manifest.files[previous];
    if (!entry?.writable || workspace.manifest.files[operation.file]) throw new Error('Workspace changed while awaiting approval');
    await chmod(path.join(workspace.directory, 'libraries'), 0o700);
    try {
      await writeFile(path.join(workspace.directory, operation.file), operation.content, { flag: 'wx', mode: 0o600 });
      await rm(this.resolveReference(workspace, previous));
    } finally { await chmod(path.join(workspace.directory, 'libraries'), 0o500); }
    delete workspace.manifest.files[previous];
    workspace.manifest.files[operation.file] = { ...entry, name: operation.name, sourceHash: sha256(operation.content) };
    workspace.baselineByFile.delete(previous);
    workspace.baselineByFile.set(operation.file, operation.content);
    if (workspace.activeFile === previous) workspace.activeFile = operation.file;
    await this.saveManifest(workspace);
    for (const file of ['AGENTS.md', '.opencode/skills/validate-vsac/SKILL.md', ...(await readdir(path.join(workspace.directory, '.opencode/commands'))).map(name => `.opencode/commands/${name}`)]) {
      if (!file) continue;
      const absolute = path.join(workspace.directory, file);
      const content = await readFile(absolute, 'utf8');
      await chmod(absolute, 0o600);
      try { await writeFile(absolute, content.replaceAll(previous, operation.file)); }
      finally { await chmod(absolute, 0o400); }
    }
  }

  async removeLibrary(workspace: MaterializedWorkspace, libraryId: string): Promise<void> {
    const file = this.fileForLibrary(workspace, libraryId);
    const directory = path.dirname(this.resolveReference(workspace, file));
    await chmod(directory, 0o700);
    try { await rm(this.resolveReference(workspace, file)); }
    finally { await chmod(directory, 0o500); }
    delete workspace.manifest.files[file];
    workspace.baselineByFile.delete(file);
    if (workspace.activeFile === file) {
      workspace.activeFile = Object.keys(workspace.manifest.files).find(candidate => workspace.manifest.files[candidate].writable) ?? '';
      workspace.manifest.activeLibraryId = workspace.manifest.files[workspace.activeFile]?.libraryId ?? '';
    }
    await this.saveManifest(workspace);
  }

  librarySnapshots(workspace: MaterializedWorkspace): OpenCodeLibraryInput[] {
    return [...workspace.baselineByFile].map(([file, cqlContent]) => {
      const entry = workspace.manifest.files[file];
      return { id: entry.libraryId, name: entry.name, version: entry.version, canonicalUrl: entry.canonicalUrl,
        fhirVersionId: entry.fhirVersionId, workspaceOrigin: entry.workspaceOrigin, cqlContent };
    });
  }

  async assertWorkspaceIntegrity(workspace: MaterializedWorkspace): Promise<void> {
    const librariesDirectory = path.join(workspace.directory, 'libraries');
    const expected = new Set(
      Object.keys(workspace.manifest.files)
        .filter(file => file.startsWith('libraries/'))
        .map(file => path.basename(file))
    );
    const unmanaged = (await readdir(librariesDirectory, { withFileTypes: true }))
      .filter(entry => !entry.isFile() || !expected.has(entry.name))
      .map(entry => `libraries/${entry.name}`);
    if (unmanaged.length) {
      throw new OpenCodeError(
        'WORKSPACE_INTEGRITY_VIOLATION',
        `OpenCode created an unmanaged workspace path: ${unmanaged.join(', ')}`,
        409,
        false
      );
    }
  }

  async diff(workspace: MaterializedWorkspace): Promise<OpenCodeFileDiffDto[]> {
    await this.assertWorkspaceIntegrity(workspace);
    const diffs: OpenCodeFileDiffDto[] = [];
    for (const [file, before] of workspace.baselineByFile) {
      const after = await readFile(path.join(workspace.directory, file), 'utf8');
      if (after === before) continue;
      const counts = countChangedLines(before, after);
      diffs.push({
        file,
        libraryId: workspace.manifest.files[file].libraryId,
        before,
        after,
        ...counts,
      });
    }
    return diffs;
  }

  async syncActiveFile(workspace: MaterializedWorkspace, content: string, libraryId = workspace.manifest.activeLibraryId): Promise<void> {
    await this.assertWorkspaceIntegrity(workspace);
    const file = this.fileForLibrary(workspace, libraryId);
    if (!workspace.manifest.files[file].writable) throw new Error('Library is read-only');
    await writeFile(this.resolveReference(workspace, file), content, { encoding: 'utf8', mode: 0o600 });
    workspace.baselineByFile.set(file, content);
  }

  async readActiveFile(workspace: MaterializedWorkspace): Promise<string> {
    return readFile(this.resolveReference(workspace, workspace.activeFile), 'utf8');
  }

  async addAttachment(workspace: MaterializedWorkspace, input: OpenCodeAttachmentInput): Promise<OpenCodeAttachmentDto> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 200) throw new Error('Attachment filename is invalid');
    if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) {
      throw new Error('Attachment data must be base64 encoded');
    }
    const bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length) throw new Error('Attachment is empty');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit`);

    const id = randomUUID();
    const extension = path.extname(name).toLowerCase();
    const stem = safeSegment(extension ? name.slice(0, -extension.length) : name, 'attachment');
    const temporary = path.join(workspace.directory, 'attachments', `.upload-${id}`);
    const converted = MARKITDOWN_EXTENSIONS.has(extension);
    const declaredText = TEXT_EXTENSIONS.has(extension) || (input.mimeType || '').toLowerCase().startsWith('text/');
    // Browsers frequently omit a MIME type for uncommon text extensions. Treat
    // valid UTF-8 without NUL bytes as text, while keeping binary uploads out.
    let decodedText: string | undefined;
    if (!converted && !declaredText && !bytes.includes(0)) {
      try {
        decodedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        decodedText = undefined;
      }
    }
    const text = declaredText || (!BINARY_EXTENSIONS.has(extension) && decodedText !== undefined);
    if (!converted && !text) {
      throw new Error('Unsupported attachment type. Upload a text file, PDF, or DOCX document.');
    }

    await writeFile(temporary, bytes, { mode: 0o600 });
    try {
      let content: string;
      if (converted) {
        if (!this.markitdownBin) {
          throw new Error(
            "PDF/DOCX conversion requires MarkItDown. Install it with: python3 -m pip install 'markitdown[pdf,docx]==0.1.7'"
          );
        }
        try {
          const result = await execFileAsync(this.markitdownBin, [temporary], {
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: MAX_CONVERTED_BYTES,
          });
          content = result.stdout;
        } catch (error) {
          const detail = error instanceof Error ? error.message.split('\n')[0] : 'conversion failed';
          throw new Error(`Could not convert ${name} with MarkItDown: ${detail}`);
        }
      } else {
        content = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
      if (!content.trim()) throw new Error(`Attachment ${name} did not contain readable text`);
      if (Buffer.byteLength(content, 'utf8') > MAX_CONVERTED_BYTES) {
        throw new Error(`Converted attachment exceeds the ${MAX_CONVERTED_BYTES / 1024 / 1024} MB text limit`);
      }
      const outputName = `${id.slice(0, 8)}-${stem}${converted ? '.md' : (extension || '.txt')}`;
      const relativePath = `attachments/${outputName}`;
      const outputPath = path.join(workspace.directory, relativePath);
      const header = converted ? `<!-- Converted from ${name} by MarkItDown -->\n\n` : '';
      await writeFile(outputPath, `${header}${content}`, { encoding: 'utf8', mode: 0o400 });
      return {
        id,
        name,
        mimeType: input.mimeType?.trim() || 'application/octet-stream',
        size: bytes.length,
        path: relativePath,
        converted,
        createdAt: new Date().toISOString(),
      };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async removeAttachment(workspace: MaterializedWorkspace, attachment: OpenCodeAttachmentDto): Promise<void> {
    const relative = attachment.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!relative.startsWith('attachments/') || relative.includes('..')) throw new Error('Attachment path is invalid');
    const resolved = path.resolve(workspace.directory, relative);
    if (!resolved.startsWith(`${path.join(workspace.directory, 'attachments')}${path.sep}`)) throw new Error('Attachment path escaped the workspace');
    await rm(resolved, { force: true });
  }

  async ensureProviderModel(workspace: MaterializedWorkspace, provider: OpenCodeProviderConfig, model: string): Promise<void> {
    const normalizedModel = model.trim();
    if (!normalizedModel || normalizedModel.length > 200) throw new Error('Provider model is invalid');
    const configPath = path.join(workspace.directory, 'opencode.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider?: Record<string, { models?: Record<string, unknown>; options?: Record<string, unknown>; npm?: string; name?: string }>;
    };
    const id = providerIdFor(provider);
    const providerConfig = config.provider?.[id];
    if (!providerConfig) throw new Error(`Provider is not configured for this session: ${id}`);
    providerConfig.models ??= {};
    providerConfig.models[normalizedModel] = {
      name: normalizedModel,
      options: { reasoningEffort: 'none' },
      variants: {
        fast: { reasoningEffort: 'none' },
        thinking: { reasoningEffort: 'medium' },
      },
    };
    // Keep the provider credentials/config read-only to the OpenCode process, but
    // briefly grant the runner owner write access while it updates the selected
    // model. `writeFile` does not change an existing file's mode, so attempting to
    // write the 0400 config directly fails with EACCES in the runner container.
    await chmod(configPath, 0o600);
    try {
      await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    } finally {
      await chmod(configPath, 0o400).catch(() => undefined);
    }
  }

  isActiveFile(workspace: MaterializedWorkspace, candidate: string): boolean {
    const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized === workspace.activeFile) return true;
    const absolute = path.resolve(workspace.directory, candidate);
    return absolute === this.resolveReference(workspace, workspace.activeFile);
  }

  references(workspace: MaterializedWorkspace, query = '', limit = 30): Array<{ path: string; libraryId: string; name: string; writable: boolean }> {
    const normalized = query.trim().toLowerCase().replace(/^@/, '');
    return Object.entries(workspace.manifest.files)
      .filter(([file]) => file.toLowerCase().endsWith('.cql') && (!normalized || file.toLowerCase().includes(normalized)))
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map(([file, entry]) => ({ path: file, libraryId: entry.libraryId, name: path.basename(file), writable: entry.writable }));
  }

  resolveReference(workspace: MaterializedWorkspace, relativeFile: string): string {
    const normalized = relativeFile.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!workspace.manifest.files[normalized] || !normalized.toLowerCase().endsWith('.cql')) {
      throw new Error(`CQL workspace reference is not allowed: ${relativeFile}`);
    }
    const absolute = path.resolve(workspace.directory, normalized);
    if (!absolute.startsWith(`${workspace.directory}${path.sep}`)) {
      throw new Error(`CQL workspace reference escaped the workspace: ${relativeFile}`);
    }
    return absolute;
  }

  async validationPayload(workspace: MaterializedWorkspace, requestedFile?: string): Promise<{
    activeFile: string;
    files: Array<{ path: string; content: string; writable: boolean }>;
  }> {
    const activeFile = requestedFile || workspace.activeFile;
    this.resolveReference(workspace, activeFile);
    const files = await Promise.all(Object.entries(workspace.manifest.files).map(async ([file, entry]) => ({
      path: file,
      content: await readFile(this.resolveReference(workspace, file), 'utf8'),
      writable: entry.writable,
    })));
    return { activeFile, files };
  }

  async remove(workspace: MaterializedWorkspace): Promise<void> {
    const resolved = path.resolve(workspace.directory);
    if (path.dirname(resolved) !== this.root) {
      throw new Error('Refusing to remove a workspace outside the configured root');
    }
    // Workspace directories are intentionally locked while a session is active;
    // unlock them only for runner-owned cleanup.
    await chmod(path.join(resolved, 'dependencies'), 0o700).catch(() => undefined);
    await chmod(path.join(resolved, 'libraries'), 0o700).catch(() => undefined);
    await rm(resolved, { recursive: true, force: true });
  }
}
