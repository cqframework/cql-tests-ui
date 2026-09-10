// Author: Preston Lee

import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeToolExecutor } from '../src/opencode/tools.js';

const live = process.env.OPENCODE_LIVE_TESTS === '1';

test('live Ollama model responds through its OpenAI-compatible endpoint', { skip: !live, timeout: 300_000 }, async () => {
  const base = (process.env.OPENCODE_LIVE_OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
  const model = process.env.OPENCODE_LIVE_OLLAMA_MODEL || 'qwen3.8:27b-mlx';
  const tags = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(tags.ok, true, `Ollama tags returned ${tags.status}`);
  const catalog = await tags.json() as { models?: Array<{ name?: string; model?: string }> };
  assert.ok(catalog.models?.some(item => item.name === model || item.model === model), `${model} is not installed`);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: CQL Studio live test OK' }],
      max_tokens: 64,
      stream: false,
      reasoning_effort: 'none',
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const responseText = await response.text();
  assert.equal(response.ok, true, `Ollama chat returned ${response.status}: ${responseText.slice(0, 500)}`);
  const body = JSON.parse(responseText) as { choices?: Array<{ message?: { content?: string } }> };
  assert.ok(body.choices?.[0]?.message?.content?.trim(), 'Ollama returned no assistant content');
});

test('live FHIR endpoint supports read-only metadata and Library search', { skip: !live || !process.env.OPENCODE_LIVE_FHIR_URL, timeout: 60_000 }, async () => {
  const base = process.env.OPENCODE_LIVE_FHIR_URL!.replace(/\/+$/, '');
  for (const relative of ['metadata', 'Library?_count=1&_elements=id,url,name,title,version,status']) {
    const response = await fetch(`${base}/${relative}`, {
      headers: { accept: 'application/fhir+json, application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.ok, true, `FHIR ${relative} returned ${response.status}`);
  }
  const tools = new OpenCodeToolExecutor();
  const environment = {
    contentEndpoint: { address: base },
    dataEndpoint: { address: base },
  };
  const libraries = await tools.execute('cql_library_search', { count: 1 }, { environment }) as { libraries?: unknown[] };
  assert.ok(Array.isArray(libraries.libraries));
  const patients = await tools.execute('fhir_search', {
    resourceType: 'Patient', query: {}, count: 1,
  }, { environment }) as { resourceType?: string };
  assert.equal(patients.resourceType, 'Bundle');
});

test('live VSAC endpoint supports read-only ValueSet search', {
  skip: !live || !process.env.OPENCODE_LIVE_VSAC_PASSWORD,
  timeout: 60_000,
}, async () => {
  const base = (process.env.OPENCODE_LIVE_VSAC_URL || 'https://cts.nlm.nih.gov/fhir').replace(/\/+$/, '');
  const username = process.env.OPENCODE_LIVE_VSAC_USERNAME;
  const password = process.env.OPENCODE_LIVE_VSAC_PASSWORD;
  const tools = new OpenCodeToolExecutor();
  const result = await tools.execute('vsac_search', { title: 'diabetes', count: 1 }, {
    toolContext: {
      vsacFhirBaseUrl: base,
      vsacApiUsername: username,
      vsacApiPassword: password,
    },
  }) as { count?: number; results?: unknown[] };
  assert.ok(Array.isArray(result.results));
});
