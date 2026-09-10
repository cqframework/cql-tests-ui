// Author: Preston Lee

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  rewriteAuthorizationUrlForBrowser,
  wrapOidcDiscoveryError,
} from '../src/auth/oidc.ts';

describe('rewriteAuthorizationUrlForBrowser', () => {
  it('leaves the URL unchanged when no browser base is configured', () => {
    const input = new URL(
      'http://authentik-server:9000/application/o/authorize/?client_id=cql-studio-development&state=abc'
    );
    assert.equal(rewriteAuthorizationUrlForBrowser(input, undefined).href, input.href);
  });

  it('rewrites only the origin for browser redirects', () => {
    const input = new URL(
      'http://host.docker.internal:9000/application/o/authorize/?client_id=cql-studio-development&state=abc'
    );
    const rewritten = rewriteAuthorizationUrlForBrowser(input, 'http://localhost:9000');
    assert.equal(
      rewritten.href,
      'http://localhost:9000/application/o/authorize/?client_id=cql-studio-development&state=abc'
    );
  });
});

describe('wrapOidcDiscoveryError', () => {
  it('maps non-conform discovery responses to an actionable message', () => {
    const err = Object.assign(new Error('unexpected HTTP response status code'), {
      code: 'OAUTH_RESPONSE_IS_NOT_CONFORM',
      cause: new Response(null, { status: 404, statusText: 'Not Found' }),
    });
    const wrapped = wrapOidcDiscoveryError(
      err,
      'http://localhost:9000/application/o/cql-studio/'
    );
    assert.match(wrapped.message, /HTTP 404/);
    assert.match(wrapped.message, /blueprint/);
    assert.match(wrapped.message, /localhost:9000\/application\/o\/cql-studio/);
  });
});
