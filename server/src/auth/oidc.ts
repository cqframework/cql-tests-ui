// Author: Preston Lee

import * as client from 'openid-client';
import type { Configuration } from 'openid-client';
import type { ServerEnv } from '../config/env.js';
import { logger } from '../logger.js';

const configBySecret = new Map<string, Configuration>();

function discoveryOptionsForIssuer(
  issuerUrl: string
): client.DiscoveryRequestOptions | undefined {
  if (!issuerUrl.startsWith('http://')) {
    return undefined;
  }
  // Must pass the library's allowInsecureRequests reference — performDiscovery checks
  // execute.includes(allowInsecureRequests) by identity, not merely calling it on the config.
  // HTTP issuers are rejected at startup outside development (see loadEnv).
  return { execute: [client.allowInsecureRequests] };
}

export function wrapOidcDiscoveryError(err: unknown, issuerUrl: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
      ? err.code
      : undefined;
  const responseCause =
    err instanceof Error && err.cause instanceof Response ? err.cause : undefined;
  const errorCause =
    err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  const detail = errorCause || message;
  const unreachable =
    message === 'fetch failed' ||
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|connect/i.test(detail);
  if (unreachable) {
    const dockerHint =
      issuerUrl.includes('localhost') || issuerUrl.includes('127.0.0.1')
        ? ' If cql-studio-server runs inside Docker, localhost is the container — use the compose service name authentik-server for CQL_STUDIO_SERVER_SSO_ISSUER_URL and set CQL_STUDIO_SERVER_SSO_AUTHORIZATION_BASE_URL=http://localhost:9000 for browser redirects.'
        : '';
    return new Error(
      `Cannot reach SSO issuer at ${issuerUrl}. Start the development IdP stack (docker compose -f docker-compose.development.yml up -d) or fix the issuer URL for this runtime.${dockerHint} (${detail})`
    );
  }
  if (code === 'OAUTH_RESPONSE_IS_NOT_CONFORM' || /unexpected HTTP response status code/i.test(message)) {
    const status = responseCause?.status;
    const statusPart = status != null ? `HTTP ${status}` : message;
    return new Error(
      `SSO issuer discovery failed for ${issuerUrl} (${statusPart}). If Authentik just started, wait until the cql-studio OIDC application blueprint has applied, then retry Sign In.`
    );
  }
  return err instanceof Error ? err : new Error(message);
}

export async function getOidcConfig(
  env: ServerEnv,
  clientSecret: string = env.ssoClientSecret
): Promise<Configuration> {
  const cached = configBySecret.get(clientSecret);
  if (cached) {
    return cached;
  }
  let config: Configuration;
  try {
    config = await client.discovery(
      new URL(env.ssoIssuerUrl),
      env.ssoClientId,
      clientSecret,
      undefined,
      discoveryOptionsForIssuer(env.ssoIssuerUrl)
    );
  } catch (err) {
    throw wrapOidcDiscoveryError(err, env.ssoIssuerUrl);
  }
  configBySecret.set(clientSecret, config);
  return config;
}

/**
 * Authorization code → tokens, trying the current client secret first, then
 * previous secrets during an OIDC client-secret rotation window.
 */
export async function authorizationCodeGrantWithSecretRotation(
  env: ServerEnv,
  callbackUrl: URL,
  checks: {
    pkceCodeVerifier: string;
    expectedState: string;
    expectedNonce: string;
  }
) {
  const secrets = [env.ssoClientSecret, ...env.ssoClientSecretPrevious];
  let lastError: unknown;
  for (let i = 0; i < secrets.length; i++) {
    try {
      const config = await getOidcConfig(env, secrets[i]);
      return await client.authorizationCodeGrant(config, callbackUrl, checks);
    } catch (err) {
      lastError = err;
      if (i === secrets.length - 1 || !isLikelyClientAuthError(err)) {
        throw err;
      }
      logger.warn(
        'Token exchange failed with current/previous client secret; trying next secret during rotation'
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Token exchange failed');
}

function isLikelyClientAuthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('invalid_client') ||
    lower.includes('unauthorized_client') ||
    lower.includes('client authentication') ||
    lower.includes('401')
  );
}

export function clearOidcConfigCache(): void {
  configBySecret.clear();
}

/**
 * Rewrite the authorization URL origin for browser redirects when discovery used a
 * container-only host (e.g. authentik-server / host.docker.internal).
 */
export function rewriteAuthorizationUrlForBrowser(
  authorizationUrl: URL,
  authorizationBaseUrl: string | undefined
): URL {
  if (!authorizationBaseUrl) {
    return authorizationUrl;
  }
  const browserOrigin = new URL(authorizationBaseUrl);
  const rewritten = new URL(authorizationUrl.href);
  rewritten.protocol = browserOrigin.protocol;
  rewritten.host = browserOrigin.host;
  return rewritten;
}

export { client as oidcClient };
