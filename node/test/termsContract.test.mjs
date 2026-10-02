// The machine-readable contract of the insurer's terms routes
// (docs/api/terms-v1.openapi.json) and the code that serves them -- the
// terms key map of src/routes/policies.js and validateTierSet of
// src/dispatch/tiers.js -- are held to each other here, structurally. A path
// or method added to one and not the other, a terms key added to the route
// and not to the contract, or a tier or gap field that changes shape, fails
// this file.
//
// JSON, not YAML, for the reason notificationsContract.test.mjs gives.
//
// It touches no database, no ledger and no network: policies.js is imported
// only for its exported key map, and its db.js pool is never queried.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as policiesRoute from '../src/routes/policies.js';
import { validateTierSet } from '../src/dispatch/tiers.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'docs/api/terms-v1.openapi.json');
const FIXTURE_PATH = path.join(import.meta.dirname, '../test-support/frostStandardGapSetFixture.json');

const contract = () => JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const sorted = (values) => [...values].sort();

const TERMS_PATH = '/api/v1/terms';
const TIER_SET_PATH = '/api/v1/terms/payout-tiers/{productCode}/{perilType}';

test('the contract is valid JSON, authenticated by the same x-api-key as the notifications contract', () => {
  const c = contract();
  assert.equal(c.openapi, '3.0.3');
  assert.deepEqual(c.components.securitySchemes.ApiKeyAuth, { type: 'apiKey', in: 'header', name: 'x-api-key' });
  assert.deepEqual(c.security, [{ ApiKeyAuth: [] }]);
});

test('the contract lists exactly the terms paths and methods the router serves', () => {
  const c = contract();
  const methods = Object.fromEntries(Object.entries(c.paths).map(([p, item]) => [p, sorted(Object.keys(item).filter((k) => k !== 'parameters'))]));
  assert.deepEqual(methods, {
    [TERMS_PATH]: ['get', 'put'],
    [TIER_SET_PATH]: ['delete', 'get', 'put'],
  });
  const routes = policiesRoute.policiesRouter.stack
    .filter((layer) => layer.route?.path.startsWith('/terms'))
    .map((layer) => `${sorted(Object.keys(layer.route.methods)).join(',')} /api/v1${layer.route.path.replace(/:(\w+)/g, '{$1}')}`);
  assert.deepEqual(sorted(routes), sorted([
    `get ${TERMS_PATH}`, `put ${TERMS_PATH}`,
    `get ${TIER_SET_PATH}`, `put ${TIER_SET_PATH}`, `delete ${TIER_SET_PATH}`,
  ]));
});

test('every operation answers 200 and 401, and 400 and 404 where the route can refuse', () => {
  const c = contract();
  const codes = (p, m) => sorted(Object.keys(c.paths[p][m].responses));
  assert.deepEqual(codes(TERMS_PATH, 'get'), ['200', '401']);
  assert.deepEqual(codes(TERMS_PATH, 'put'), ['200', '400', '401']);
  assert.deepEqual(codes(TIER_SET_PATH, 'get'), ['200', '401', '404']);
  assert.deepEqual(codes(TIER_SET_PATH, 'put'), ['200', '400', '401']);
  assert.deepEqual(codes(TIER_SET_PATH, 'delete'), ['200', '401', '404']);
  for (const [, item] of Object.entries(c.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'parameters') continue;
      assert.deepEqual(op.security, [{ ApiKeyAuth: [] }]);
      for (const [code, response] of Object.entries(op.responses)) {
        if (code === '200') continue;
        assert.deepEqual(response.content['application/json'].schema, { $ref: '#/components/schemas/Error' });
      }
    }
  }
});

test('the terms body has exactly the keys of the route\'s key map, every one required, in the PUT and both answers', () => {
  assert.ok(policiesRoute.TERMS_COLUMNS, 'src/routes/policies.js does not export TERMS_COLUMNS');
  const c = contract();
  const schema = c.components.schemas.Terms;
  const keys = sorted(Object.keys(policiesRoute.TERMS_COLUMNS));
  assert.deepEqual(sorted(Object.keys(schema.properties)), keys);
  assert.deepEqual(sorted(schema.required), keys);
  const ref = { $ref: '#/components/schemas/Terms' };
  assert.deepEqual(c.paths[TERMS_PATH].put.requestBody.content['application/json'].schema, ref);
  assert.equal(c.paths[TERMS_PATH].put.requestBody.required, true);
  assert.deepEqual(c.paths[TERMS_PATH].put.responses['200'].content['application/json'].schema, ref);
  assert.deepEqual(c.paths[TERMS_PATH].get.responses['200'].content['application/json'].schema, ref);
});

test('the Tier schema has exactly the keys of the fixture\'s tiers, the snapshot shape', () => {
  const schema = contract().components.schemas.Tier;
  for (const tier of fixture().tiers) {
    assert.deepEqual(sorted(Object.keys(schema.properties)), sorted(Object.keys(tier)));
  }
});

test('the gaps item has exactly the keys validateTierSet gives for the fixture\'s set', () => {
  const c = contract();
  const { gaps } = validateTierSet(fixture().tiers);
  assert.ok(gaps.length > 0, 'the fixture set has no gap, so this test would check nothing');
  for (const gap of gaps) {
    assert.deepEqual(sorted(Object.keys(c.components.schemas.TierGap.properties)), sorted(Object.keys(gap)));
  }
  const written = c.components.schemas.TierSetWritten.properties;
  assert.deepEqual(written.gaps.items, { $ref: '#/components/schemas/TierGap' });
  assert.deepEqual(written.tiers.items, { $ref: '#/components/schemas/Tier' });
});
