// Author: Preston Lee

import { CqlEnvironment } from './environment.model';

export enum ThemeType {
    AUTOMATIC = 'automatic',
    LIGHT = 'light',
    DARK = 'dark'
}

export type ActiveEnvironmentSource = 'personal' | 'workspace';

export type AiProviderType = 'ollama' | 'openai' | 'openai-compatible';

export interface ActiveWorkspaceEnvironmentRef {
    workspaceId: string;
    environmentId: string;
}

export class Settings {
    public experimental: boolean = false;
    public developer: boolean = false;
    public theme_preferred: ThemeType = ThemeType.AUTOMATIC;
    public validateSchema: boolean = false;
    public runnerApiBaseUrl: string = '';
    public runnerFhirBaseUrl: string = '';
    public defaultTestResultsIndexUrl: string = '';
    /** Personal environments only (excludes virtual Default Environment). */
    public environments: CqlEnvironment[] = [];

    /** FHIR NPM package registry (normative default https://packages.fhir.org). */
    public fhirPackageRegistryBaseUrl: string = '';

    /** VSAC (NLM CTS / vsac.nlm.nih.gov) — UMLS API key auth; VSAC Browser always calls NLM via CQL Studio Server (no CORS). */
    public vsacFhirBaseUrl: string = '';
    public vsacApiUsername: string = '';
    public vsacApiPassword: string = '';

    // AI Settings
    public aiProvider: AiProviderType = 'ollama';
    public ollamaBaseUrl: string = '';
    public ollamaModel: string = '';
    public openaiModel: string = '';
    public compatibleProviderName: string = '';
    public compatibleProviderBaseUrl: string = '';
    public compatibleProviderModel: string = '';
    public serverBaseUrl: string = '';
    public searxngBaseUrl: string = '';
    public enableAiAssistant: boolean = true;
    public autoApplyCodeEdits: boolean = true;
    public enableAiCodePrediction: boolean = true;

    public static DEFAULT_THEME = ThemeType.AUTOMATIC;
}
