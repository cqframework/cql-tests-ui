// Author: Preston Lee

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { SharedEnvironmentConfig, UserSettingsDto } from '@cql-studio/core';
import { getPrisma } from '../db/prisma.js';
import type { ServerEnv } from '../config/env.js';
import { requireAuth } from '../auth/session.js';
import {
  addressesFromConfig,
  headerRowsFromConfig,
  parseUserEnvironmentInput,
  userEnvironmentDtoFromRow,
} from './environment-persist.js';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const SETTINGS_SELECT = {
  experimental: true,
  developer: true,
  themePreferred: true,
  validateSchema: true,
  runnerApiBaseUrl: true,
  runnerFhirBaseUrl: true,
  defaultTestResultsIndexUrl: true,
  fhirPackageRegistryBaseUrl: true,
  vsacFhirBaseUrl: true,
  vsacApiUsername: true,
  vsacApiPassword: true,
  aiProvider: true,
  ollamaBaseUrl: true,
  ollamaModel: true,
  openaiModel: true,
  compatibleProviderName: true,
  compatibleProviderBaseUrl: true,
  compatibleProviderModel: true,
  searxngBaseUrl: true,
  enableAiAssistant: true,
  autoApplyCodeEdits: true,
  enableAiCodePrediction: true,
} as const;

function toSettingsDto(row: {
  experimental: boolean;
  developer: boolean;
  themePreferred: string;
  validateSchema: boolean;
  runnerApiBaseUrl: string;
  runnerFhirBaseUrl: string;
  defaultTestResultsIndexUrl: string;
  fhirPackageRegistryBaseUrl: string;
  vsacFhirBaseUrl: string;
  vsacApiUsername: string;
  vsacApiPassword: string;
  aiProvider: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiModel: string;
  compatibleProviderName: string;
  compatibleProviderBaseUrl: string;
  compatibleProviderModel: string;
  searxngBaseUrl: string;
  enableAiAssistant: boolean;
  autoApplyCodeEdits: boolean;
  enableAiCodePrediction: boolean;
}): UserSettingsDto {
  const aiProvider = row.aiProvider === 'openai' || row.aiProvider === 'openai-compatible'
    ? row.aiProvider
    : 'ollama';
  return { ...row, aiProvider };
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function settingsPatchFromBody(body: unknown): Partial<UserSettingsDto> {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<UserSettingsDto> = {};
  const bool = (key: keyof UserSettingsDto) => {
    const v = parseBoolean(b[key]);
    if (v !== undefined) {
      (patch as Record<string, unknown>)[key] = v;
    }
  };
  const str = (key: keyof UserSettingsDto) => {
    const v = parseString(b[key]);
    if (v !== undefined) {
      (patch as Record<string, unknown>)[key] = v;
    }
  };
  bool('experimental');
  bool('developer');
  str('themePreferred');
  bool('validateSchema');
  str('runnerApiBaseUrl');
  str('runnerFhirBaseUrl');
  str('defaultTestResultsIndexUrl');
  str('fhirPackageRegistryBaseUrl');
  str('vsacFhirBaseUrl');
  str('vsacApiUsername');
  str('vsacApiPassword');
  const aiProvider = parseString(b['aiProvider']);
  if (aiProvider === 'ollama' || aiProvider === 'openai' || aiProvider === 'openai-compatible') {
    patch.aiProvider = aiProvider;
  }
  str('ollamaBaseUrl');
  str('ollamaModel');
  str('openaiModel');
  str('compatibleProviderName');
  str('compatibleProviderBaseUrl');
  str('compatibleProviderModel');
  str('searxngBaseUrl');
  bool('enableAiAssistant');
  bool('autoApplyCodeEdits');
  bool('enableAiCodePrediction');
  return patch;
}

const envInclude = {
  headers: {
    orderBy: [{ name: 'asc' as const }],
  },
};

export function createUserSettingsRouter(env: ServerEnv): Router {
  const router = Router();
  router.use(requireAuth(env));

  router.get(
    '/me/settings',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const row = await getPrisma().user.findUniqueOrThrow({
        where: { id: user.id },
        select: SETTINGS_SELECT,
      });
      res.json(toSettingsDto(row));
    })
  );

  router.patch(
    '/me/settings',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const patch = settingsPatchFromBody(req.body);
      const row = await getPrisma().user.update({
        where: { id: user.id },
        data: patch,
        select: SETTINGS_SELECT,
      });
      res.json(toSettingsDto(row));
    })
  );

  router.put(
    '/me/settings',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const patch = settingsPatchFromBody(req.body);
      const data: UserSettingsDto = {
        experimental: patch.experimental ?? false,
        developer: patch.developer ?? false,
        themePreferred: patch.themePreferred ?? 'automatic',
        validateSchema: patch.validateSchema ?? false,
        runnerApiBaseUrl: patch.runnerApiBaseUrl ?? '',
        runnerFhirBaseUrl: patch.runnerFhirBaseUrl ?? '',
        defaultTestResultsIndexUrl: patch.defaultTestResultsIndexUrl ?? '',
        fhirPackageRegistryBaseUrl: patch.fhirPackageRegistryBaseUrl ?? '',
        vsacFhirBaseUrl: patch.vsacFhirBaseUrl ?? '',
        vsacApiUsername: patch.vsacApiUsername ?? '',
        vsacApiPassword: patch.vsacApiPassword ?? '',
        aiProvider: patch.aiProvider ?? 'ollama',
        ollamaBaseUrl: patch.ollamaBaseUrl ?? '',
        ollamaModel: patch.ollamaModel ?? '',
        openaiModel: patch.openaiModel ?? '',
        compatibleProviderName: patch.compatibleProviderName ?? '',
        compatibleProviderBaseUrl: patch.compatibleProviderBaseUrl ?? '',
        compatibleProviderModel: patch.compatibleProviderModel ?? '',
        searxngBaseUrl: patch.searxngBaseUrl ?? '',
        enableAiAssistant: patch.enableAiAssistant ?? true,
        autoApplyCodeEdits: patch.autoApplyCodeEdits ?? true,
        enableAiCodePrediction: patch.enableAiCodePrediction ?? true,
      };
      const row = await getPrisma().user.update({
        where: { id: user.id },
        data,
        select: SETTINGS_SELECT,
      });
      res.json(toSettingsDto(row));
    })
  );

  router.get(
    '/me/environments',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const rows = await getPrisma().userEnvironment.findMany({
        where: { userId: user.id },
        include: envInclude,
        orderBy: { name: 'asc' },
      });
      res.json(rows.map(userEnvironmentDtoFromRow));
    })
  );

  router.put(
    '/me/environments',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      if (!Array.isArray(req.body)) {
        res.status(400).json({ error: 'body must be an array of environments' });
        return;
      }
      const parsed = req.body.map((item: unknown) => parseUserEnvironmentInput(item));
      if (parsed.some((p) => !p)) {
        res.status(400).json({ error: 'each environment requires a name' });
        return;
      }
      const envs = parsed.filter(
        (p): p is { name: string; config: SharedEnvironmentConfig } => p != null
      );

      const names = envs.map((e) => e.name);
      if (new Set(names).size !== names.length) {
        res.status(400).json({ error: 'environment names must be unique' });
        return;
      }

      const prisma = getPrisma();
      const rows = await prisma.$transaction(async (tx) => {
        await tx.userEnvironment.deleteMany({ where: { userId: user.id } });
        const created = [];
        for (const envInput of envs) {
          const addresses = addressesFromConfig(envInput.config);
          const headers = headerRowsFromConfig(envInput.config);
          const row = await tx.userEnvironment.create({
            data: {
              userId: user.id,
              name: envInput.name,
              ...addresses,
              headers: {
                create: headers,
              },
            },
            include: envInclude,
          });
          created.push(row);
        }
        return created;
      });
      res.json(rows.map(userEnvironmentDtoFromRow));
    })
  );

  router.post(
    '/me/environments',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const parsed = parseUserEnvironmentInput(req.body);
      if (!parsed) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const addresses = addressesFromConfig(parsed.config);
      const headers = headerRowsFromConfig(parsed.config);
      try {
        const row = await getPrisma().userEnvironment.create({
          data: {
            userId: user.id,
            name: parsed.name,
            ...addresses,
            headers: { create: headers },
          },
          include: envInclude,
        });
        res.status(201).json(userEnvironmentDtoFromRow(row));
      } catch {
        res.status(409).json({ error: 'environment name already exists' });
      }
    })
  );

  router.patch(
    '/me/environments/:id',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const existing = await getPrisma().userEnvironment.findFirst({
        where: { id: req.params.id, userId: user.id },
      });
      if (!existing) {
        res.status(404).json({ error: 'Environment not found' });
        return;
      }

      const name =
        typeof req.body?.name === 'string' && req.body.name.trim()
          ? req.body.name.trim()
          : undefined;
      const hasEndpointFields =
        req.body &&
        typeof req.body === 'object' &&
        (req.body.config !== undefined ||
          req.body.evaluationServer !== undefined ||
          req.body.dataEndpoint !== undefined ||
          req.body.terminologyEndpoint !== undefined ||
          req.body.contentEndpoint !== undefined);

      let config: SharedEnvironmentConfig | null = null;
      if (hasEndpointFields) {
        const parsed = parseUserEnvironmentInput({
          name: name ?? existing.name,
          ...(req.body.config !== undefined
            ? { config: req.body.config }
            : {
                evaluationServer: req.body.evaluationServer,
                dataEndpoint: req.body.dataEndpoint,
                terminologyEndpoint: req.body.terminologyEndpoint,
                contentEndpoint: req.body.contentEndpoint,
              }),
        });
        if (!parsed) {
          res.status(400).json({ error: 'invalid environment payload' });
          return;
        }
        config = parsed.config;
      }

      try {
        const row = await getPrisma().$transaction(async (tx) => {
          if (config) {
            await tx.userEnvironmentHttpHeader.deleteMany({
              where: { environmentId: existing.id },
            });
            const addresses = addressesFromConfig(config);
            const headers = headerRowsFromConfig(config);
            return tx.userEnvironment.update({
              where: { id: existing.id },
              data: {
                ...(name ? { name } : {}),
                ...addresses,
                headers: { create: headers },
              },
              include: envInclude,
            });
          }
          return tx.userEnvironment.update({
            where: { id: existing.id },
            data: name ? { name } : {},
            include: envInclude,
          });
        });
        res.json(userEnvironmentDtoFromRow(row));
      } catch {
        res.status(409).json({ error: 'environment name already exists' });
      }
    })
  );

  router.delete(
    '/me/environments/:id',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const existing = await getPrisma().userEnvironment.findFirst({
        where: { id: req.params.id, userId: user.id },
      });
      if (!existing) {
        res.status(404).json({ error: 'Environment not found' });
        return;
      }
      await getPrisma().userEnvironment.delete({ where: { id: existing.id } });
      res.status(204).send();
    })
  );

  return router;
}
