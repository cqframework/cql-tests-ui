// Author: Preston Lee

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getPrisma } from '../db/prisma.js';
import type { ServerEnv } from '../config/env.js';
import { logger } from '../logger.js';
import {
  authorizationCodeGrantWithSecretRotation,
  getOidcConfig,
  oidcClient,
  rewriteAuthorizationUrlForBrowser,
} from './oidc.js';
import { hmacSign, hmacVerify } from './hmac.js';
import {
  clearSessionCookie,
  optionalAuth,
  publicUser,
  SESSION_COOKIE,
  sessionCookieOptions,
  setSessionCookie,
  verifySessionCookie,
} from './session.js';

const LOGIN_STATE_COOKIE = 'cql_studio_oidc_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface LoginState {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

/** Path-only return targets for the Studio UI (blocks //open-redirect and absolute URLs). */
export function sanitizeReturnToPath(returnTo: string | undefined): string {
  if (
    typeof returnTo !== 'string' ||
    !returnTo.startsWith('/') ||
    returnTo.startsWith('//') ||
    returnTo.includes('\\') ||
    returnTo.includes('://')
  ) {
    return '/';
  }
  return returnTo;
}

export function resolveUiReturnUrl(uiBaseUrl: string, returnTo: string | undefined): string {
  const base = uiBaseUrl.replace(/\/+$/, '');
  return `${base}${sanitizeReturnToPath(returnTo)}`;
}

function encodeLoginState(state: LoginState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return hmacSign(payload, secret);
}

function decodeLoginState(raw: string, secrets: readonly string[]): LoginState | null {
  const verified = hmacVerify(raw, secrets);
  if (!verified) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(verified.payload, 'base64url').toString('utf8')) as LoginState;
  } catch {
    return null;
  }
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function createAuthRouter(env: ServerEnv): Router {
  const router = Router();

  router.get(
    '/session',
    optionalAuth(env),
    asyncHandler(async (req, res) => {
      res.json({
        enabled: true,
        user: req.user ? publicUser(req.user) : null,
      });
    })
  );

  router.get(
    '/login',
    asyncHandler(async (req, res) => {
      const config = await getOidcConfig(env);
      const codeVerifier = oidcClient.randomPKCECodeVerifier();
      const codeChallenge = await oidcClient.calculatePKCECodeChallenge(codeVerifier);
      const state = oidcClient.randomState();
      const nonce = oidcClient.randomNonce();
      const returnTo = sanitizeReturnToPath(
        typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined
      );

      const loginState: LoginState = { codeVerifier, state, nonce, returnTo };
      res.cookie(LOGIN_STATE_COOKIE, encodeLoginState(loginState, env.sessionSecret), {
        ...sessionCookieOptions(env),
        maxAge: 10 * 60 * 1000,
      });

      const redirectTo = rewriteAuthorizationUrlForBrowser(
        oidcClient.buildAuthorizationUrl(config, {
          redirect_uri: env.ssoRedirectUrl,
          scope: env.ssoScopes,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state,
          nonce,
        }),
        env.ssoAuthorizationBaseUrl
      );
      res.redirect(redirectTo.href);
    })
  );

  router.get(
    '/callback',
    asyncHandler(async (req, res) => {
      const rawState = req.cookies?.[LOGIN_STATE_COOKIE] as string | undefined;
      res.clearCookie(LOGIN_STATE_COOKIE, { path: '/' });
      if (!rawState) {
        res.status(400).json({ error: 'Missing login state' });
        return;
      }
      const loginState = decodeLoginState(rawState, env.sessionSecrets);
      if (!loginState) {
        res.status(400).json({ error: 'Invalid login state' });
        return;
      }

      const currentUrl = new URL(req.originalUrl, `${req.protocol}://${req.get('host')}`);
      const callbackUrl = new URL(env.ssoRedirectUrl);
      callbackUrl.search = currentUrl.search;

      const tokens = await authorizationCodeGrantWithSecretRotation(env, callbackUrl, {
        pkceCodeVerifier: loginState.codeVerifier,
        expectedState: loginState.state,
        expectedNonce: loginState.nonce,
      });

      const claims = tokens.claims();
      if (!claims?.sub) {
        res.status(400).json({ error: 'ID token missing sub claim' });
        return;
      }

      const email =
        typeof claims.email === 'string'
          ? claims.email
          : typeof claims.preferred_username === 'string'
            ? claims.preferred_username
            : null;
      const displayName =
        typeof claims.name === 'string'
          ? claims.name
          : typeof claims.preferred_username === 'string'
            ? claims.preferred_username
            : email;

      const prisma = getPrisma();
      const user = await prisma.user.upsert({
        where: {
          ssoIssuer_ssoSubject: {
            ssoIssuer: env.ssoIssuerUrl,
            ssoSubject: claims.sub,
          },
        },
        create: {
          ssoIssuer: env.ssoIssuerUrl,
          ssoSubject: claims.sub,
          email,
          displayName,
          lastLoginAt: new Date(),
        },
        update: {
          email: email ?? undefined,
          displayName: displayName ?? undefined,
          lastLoginAt: new Date(),
        },
      });

      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      const session = await prisma.session.create({
        data: { userId: user.id, expiresAt },
      });
      setSessionCookie(res, session.id, env, expiresAt);
      logger.debug(
        {
          userId: user.id,
          issuer: env.ssoIssuerUrl,
        },
        'SSO login completed'
      );
      res.redirect(resolveUiReturnUrl(env.uiBaseUrl, loginState.returnTo));
    })
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const raw = req.cookies?.[SESSION_COOKIE] as string | undefined;
      if (raw) {
        const verified = verifySessionCookie(raw, env.sessionSecrets);
        if (verified) {
          await getPrisma()
            .session.delete({ where: { id: verified.sessionId } })
            .catch(() => undefined);
        }
      }
      clearSessionCookie(res, env);
      res.json({ ok: true });
    })
  );

  return router;
}
