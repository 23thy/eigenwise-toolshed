'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcess, startGateway } = require('./support.js');

const STATE_MODULE = path.join(__dirname, '..', 'lib', 'codex-upstream-state.js');
const RUNTIME_MODULE = path.join(__dirname, '..', 'lib', 'runtime.js');
const EMPTY_COMPLETION = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Codex completed without producing output' } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const headers = body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), ms: Date.now() - started }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function codexMessage(stream) {
  return JSON.stringify({ model: 'claude-gpt-5.6-sol', max_tokens: 64, stream, messages: [{ role: 'user', content: 'hi' }] });
}

async function codexReadiness(port) {
  return JSON.parse((await request(port, 'GET', '/healthz')).body).codexReadiness;
}

async function workerBehind(t, answerInference, environment = {}, { modelsStatus = 200 } = {}) {
  const proxy = { modelsFetches: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      proxy.modelsFetches++;
      res.writeHead(modelsStatus, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    req.resume();
    req.once('end', () => answerInference(res));
  });
  const proxyPort = await listen(server);
  t.after(() => server.close());
  const { port } = await startGateway(t, 'serve-worker', {
    ...environment,
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_USAGE_ENDPOINT: '0',
  });
  return { port, proxy };
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const FINISHED_TURN_WITHOUT_STOP = [
  { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'gpt-5.6-sol', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hand-back report' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
];

function runInGatewayHome(t, script) {
  return new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(t, process.execPath, ['-e', script], { env: gatewayTestEnvironment(t), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`state child exited ${code}: ${stderr}`)));
  });
}

test('#190: a 429 block expires at its Retry-After, the proxy reset, or 60 s; 401 waits for setup', async (t) => {
  const result = await runInGatewayHome(t, `
    const state = require(${JSON.stringify(STATE_MODULE)});
    const { codexReadinessMessage } = require(${JSON.stringify(RUNTIME_MODULE)});
    const now = Date.parse('2026-09-28T10:00:00Z');
    const block = (statusCode, headers) => state.setUpstreamBlocked({ statusCode, evidence: 'headers:x-openai-request-id', headers, now });
    const seconds = block(429, { 'retry-after': '30' });
    const httpDate = block(429, { 'retry-after': 'Mon, 28 Sep 2026 10:05:00 GMT' });
    const proxyReset = block(429, { 'anthropic-ratelimit-unified-reset': String(Date.parse('2026-09-28T12:15:00Z') / 1000) });
    const fallback = block(429, undefined);
    const beforeExpiry = state.readUpstreamBlocked(now + state.RATE_LIMIT_BLOCK_DEFAULT_MS - 1);
    const afterExpiry = state.readUpstreamBlocked(now + state.RATE_LIMIT_BLOCK_DEFAULT_MS);
    const rateLimitedMessage = codexReadinessMessage('upstream-blocked', 'gw', fallback);
    const credential = block(401, { 'retry-after': '30' });
    const credentialNextDay = state.readUpstreamBlocked(now + 86400000);
    process.stdout.write(JSON.stringify({ seconds, httpDate, proxyReset, fallback, beforeExpiry, afterExpiry, rateLimitedMessage, credential, credentialNextDay,
      credentialMessage: codexReadinessMessage('upstream-blocked', 'gw', credential) }));
  `);

  assert.equal(result.seconds.expiresAt, '2026-09-28T10:00:30.000Z');
  assert.equal(result.httpDate.expiresAt, '2026-09-28T10:05:00.000Z');
  assert.equal(result.proxyReset.expiresAt, '2026-09-28T12:15:00.000Z');
  assert.equal(result.fallback.expiresAt, '2026-09-28T10:01:00.000Z');
  assert.equal(result.beforeExpiry?.state, 'upstream-blocked');
  assert.equal(result.afterExpiry, null, 'the reader drops the block at its expiry without any request succeeding');
  assert.match(result.rateLimitedMessage, /rate-limited by OpenAI \(429\) until 2026-09-28T10:01:00\.000Z\. The block lifts by itself then/);
  assert.equal(result.credential.expiresAt, undefined);
  assert.equal(result.credentialNextDay?.state, 'upstream-blocked');
  assert.match(result.credentialMessage, /Run `node "gw" setup`/);
});

test('#175: a transient upstream failure holds for 30 s and its refusal names when it happened and when it ends', async (t) => {
  const result = await runInGatewayHome(t, `
    const state = require(${JSON.stringify(STATE_MODULE)});
    const { codexReadinessMessage } = require(${JSON.stringify(RUNTIME_MODULE)});
    const now = Date.parse('2026-09-23T15:05:55.807Z');
    const unavailable = state.setUpstreamUnavailable({ statusCode: 503, now });
    process.stdout.write(JSON.stringify({
      unavailable,
      held: state.readUpstreamUnavailable(now + 29_999),
      lifted: state.readUpstreamUnavailable(now + 30_000),
      message: codexReadinessMessage('upstream-unavailable', 'gw', unavailable),
    }));
  `);

  assert.equal(result.unavailable.expiresAt, '2026-09-23T15:06:25.807Z');
  assert.equal(result.held?.state, 'upstream-unavailable');
  assert.equal(result.lifted, null, 'the hold lifts by itself 30 s after the failure');
  assert.match(result.message, /terminal upstream failure \(HTTP 503\) at 2026-09-23T15:05:55\.807Z\. Dispatch holds until 2026-09-23T15:06:25\.807Z, or until a Codex request succeeds/);
});

test('#190: a live 429 carries its Retry-After into readiness, lifts on time, and a later 2xx clears it early', async (t) => {
  const answers = [
    { status: 429, headers: { 'retry-after': '1' } },
    { status: 429, headers: { 'retry-after': '3600' } },
    { status: 200, headers: {} },
  ];
  const { port } = await workerBehind(t, (res) => {
    const { status, headers } = answers.shift();
    res.writeHead(status, { 'content-type': 'application/json', 'x-openai-request-id': 'req_1', ...headers });
    res.end(status === 200
      ? JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
      : JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } }));
  });

  assert.equal((await request(port, 'POST', '/v1/messages', codexMessage(false))).status, 429);
  const blocked = (await codexReadiness(port)).upstreamBlocked;
  assert.equal(blocked.statusCode, 429);
  assert.equal(Date.parse(blocked.expiresAt) - Date.parse(blocked.observedAt), 1000, 'readiness shows the expiry the 429 named');
  await sleep(Math.max(0, blocked.expiresAtMs - Date.now()) + 100);
  assert.equal((await codexReadiness(port)).upstreamBlocked, null, 'the block lifted with no request in between');

  assert.equal((await request(port, 'POST', '/v1/messages', codexMessage(false))).status, 429);
  assert.equal((await codexReadiness(port)).upstreamBlocked.statusCode, 429);
  assert.equal((await request(port, 'POST', '/v1/messages', codexMessage(false))).status, 200);
  assert.equal((await codexReadiness(port)).upstreamBlocked, null, 'a successful request clears an hour-long block at once');
});

test('#192: an empty Codex completion is a typed non-retryable failure, never a successful turn', async (t) => {
  let attempts = 0;
  const answers = [EMPTY_COMPLETION, EMPTY_COMPLETION, JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream overloaded' } })];
  const { port } = await workerBehind(t, (res) => {
    attempts++;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(answers.shift());
  });

  for (const stream of [true, false]) {
    const response = await request(port, 'POST', '/v1/messages', codexMessage(stream));
    assert.equal(response.status, 422);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(response.headers['x-model-gateway-upstream-status'], '503');
    const failure = JSON.parse(response.body);
    assert.equal(failure.type, 'error');
    assert.equal(failure.error.type, 'invalid_request_error');
    assert.equal(failure.error.details.error_code, 'empty_codex_completion');
    assert.equal(failure.error.details.retryable, false);
    assert.doesNotMatch(response.body, /end_turn|message_stop/);
  }
  assert.equal(attempts, 2, 'exactly one upstream call per request; no retry spin');
  assert.equal((await codexReadiness(port)).upstreamUnavailable.statusCode, 503);
  assert.equal((await request(port, 'POST', '/v1/messages', codexMessage(true))).status, 503, 'any other 503 still reaches the client');
});

function planToolResponse(blocks, stream) {
  const message = { id: 'm_plan', type: 'message', role: 'assistant', model: 'gpt-5.6-sol', content: blocks, stop_reason: 'tool_use' };
  if (!stream) return JSON.stringify(message);
  return sse([
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    ...blocks.flatMap((content_block, index) => [
      { type: 'content_block_start', index, content_block },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]);
}

test('blocked-only plan calls fail explicitly; mixed permitted calls survive in JSON and SSE', async (t) => {
  let blocks;
  let stream;
  let attempts = 0;
  const { port } = await workerBehind(t, (res) => {
    attempts++;
    res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
    res.end(planToolResponse(blocks, stream));
  });

  for (stream of [false, true]) {
    for (const mixed of [false, true]) {
      blocks = [
        { type: 'text', text: 'I will make a plan.' },
        { type: 'tool_use', id: 'plan', name: 'EnterPlanMode', input: {} },
        { type: 'tool_use', id: 'exit', name: 'ExitPlanMode', input: {} },
      ];
      if (mixed) blocks.push({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/fixture' } });
      const response = await request(port, 'POST', '/v1/messages', codexMessage(stream));
      assert.doesNotMatch(response.body, /EnterPlanMode|ExitPlanMode|end_turn/);
      if (mixed) {
        assert.equal(response.status, 200);
        assert.match(response.body, /"name":"Read"/);
        assert.match(response.body, /"stop_reason":"tool_use"/);
        assert.doesNotMatch(response.body, /"type":"error"/);
      } else {
        assert.equal(response.status, stream ? 200 : 422);
        assert.match(response.body, /blocked_plan_tools/);
        assert.match(response.body, /"retryable":false/);
        assert.doesNotMatch(response.body, /"type":"message_stop"|"stop_reason":"tool_use"/);
      }
    }
  }
  assert.equal(attempts, 4, 'blocked plan calls never cause gateway retries');
  assert.equal((await codexReadiness(port)).upstreamUnavailable, null, 'the final permitted call succeeds');
});

test('blocked-only plan calls fail even when the upstream omits stop events', async (t) => {
  const { port } = await workerBehind(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      { type: 'message_start', message: { id: 'm_plan', type: 'message', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'plan', name: 'EnterPlanMode', input: {} } },
      { type: 'content_block_stop', index: 0 },
    ]));
  });
  const response = await request(port, 'POST', '/v1/messages', codexMessage(true));
  assert.match(response.body, /blocked_plan_tools/);
  assert.doesNotMatch(response.body, /end_turn|message_stop/);
  assert.equal((await codexReadiness(port)).upstreamUnavailable.statusCode, 200);
});

test('#192: a stream that finished its turn but lost message_stop is closed for the client; a cut-off turn is not', async (t) => {
  const answers = [FINISHED_TURN_WITHOUT_STOP, FINISHED_TURN_WITHOUT_STOP.slice(0, 3)];
  const { port } = await workerBehind(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(answers.shift()));
  });

  const finished = await request(port, 'POST', '/v1/messages', codexMessage(true));
  assert.match(finished.body, /hand-back report/);
  assert.match(finished.body, /event: message_stop\ndata: \{"type":"message_stop"\}\n\n$/);

  const cutOff = await request(port, 'POST', '/v1/messages', codexMessage(true));
  assert.doesNotMatch(cutOff.body, /message_stop/, 'a turn with no stop reason and an open block is not dressed up as finished');
});

test('#238: /v1/models refreshes on a timer and a burst of 50 never triggers a refresh or waits on file writes', async (t) => {
  const environment = gatewayTestEnvironment(t, { CODEX_GATEWAY_MODELS_REFRESH_MS: '150' });
  const modelsFile = path.join(environment.HOME, '.claude', 'model-gateway', 'models.json');
  const { port, proxy } = await workerBehind(t, (res) => { res.writeHead(500); res.end(); }, environment, { modelsStatus: 500 });
  await sleep(800);
  assert.ok(proxy.modelsFetches >= 3, `the snapshot refreshed ${proxy.modelsFetches} time(s) with no request asking`);

  fs.mkdirSync(path.dirname(modelsFile), { recursive: true });
  let rewriting = true;
  const rewrite = (async () => {
    while (rewriting) {
      fs.writeFileSync(modelsFile, JSON.stringify(Array.from({ length: 2000 }, (_, index) => `gpt-5.6-${index}`)));
      await sleep(1);
    }
  })();
  const fetchesBefore = proxy.modelsFetches;
  const started = Date.now();
  const burst = await Promise.all(Array.from({ length: 50 }, () => request(port, 'GET', '/v1/models')));
  const burstMs = Date.now() - started;
  rewriting = false;
  await rewrite;

  assert.ok(burst.every((response) => response.status === 200 && JSON.parse(response.body).data.length > 0));
  assert.ok(proxy.modelsFetches - fetchesBefore <= Math.ceil(burstMs / 150) + 1,
    `${proxy.modelsFetches - fetchesBefore} refreshes in a ${burstMs} ms burst means requests are starting them`);
  const slowest = Math.max(...burst.map((response) => response.ms));
  assert.ok(slowest < 1500, `slowest /v1/models took ${slowest} ms`);
});

test('#238 #367: a 5 s proxy auth status stalls neither /healthz nor /v1/models, and concurrent probes share one check', async (t) => {
  const environment = gatewayTestEnvironment(t);
  const home = environment.HOME;
  const bin = path.join(home, '.claude', 'model-gateway', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fakeProxy = path.join(bin, process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  try { fs.linkSync(process.execPath, fakeProxy); } catch { fs.copyFileSync(process.execPath, fakeProxy); }
  const authStarts = path.join(home, 'auth-status-starts.log');
  const slowAuthStatus = path.join(home, 'slow-auth-status.js');
  fs.writeFileSync(slowAuthStatus, [
    "if (/codex$/.test(process.argv[1] || '')) {",
    `  require('fs').appendFileSync(${JSON.stringify(authStarts)}, 'x');`,
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);',
    "  process.stdout.write('account: fixture\\n');",
    '  process.exit(0);',
    '}',
  ].join('\n'));
  environment.NODE_OPTIONS = `--require "${slowAuthStatus.replace(/\\/g, '/')}"`;
  const { port } = await workerBehind(t, (res) => { res.writeHead(500); res.end(); }, environment);

  const probes = await Promise.all(Array.from({ length: 5 }, () => request(port, 'GET', '/healthz')));
  const models = await Promise.all(Array.from({ length: 10 }, () => request(port, 'GET', '/v1/models')));

  for (const probe of probes) {
    assert.equal(probe.status, 200);
    assert.ok(probe.ms < 1000, `/healthz took ${probe.ms} ms, past the supervisor's 1000 ms probe`);
    const readiness = JSON.parse(probe.body).codexReadiness;
    assert.equal(readiness.state, 'checking', 'the auth status is still running, so nothing is confirmed yet');
    assert.equal(readiness.ready, false);
    assert.equal(readiness.checkedAt, null);
  }
  const slowest = Math.max(...models.map((response) => response.ms));
  assert.ok(slowest < 750, `/v1/models waited ${slowest} ms behind the auth status`);

  let confirmed = null;
  const deadline = Date.now() + 20000;
  while (!confirmed && Date.now() < deadline) {
    const readiness = await codexReadiness(port);
    if (readiness.checkedAt) confirmed = readiness;
    else await sleep(200);
  }
  assert.ok(confirmed, 'the background auth check never reported');
  assert.equal(confirmed.checks.codexAuth, true);
  assert.equal(confirmed.stale, false);
  assert.equal(typeof confirmed.ageMs, 'number');
  assert.equal(fs.readFileSync(authStarts, 'utf8'), 'x', 'every probe shared the one in-flight auth status');
});
