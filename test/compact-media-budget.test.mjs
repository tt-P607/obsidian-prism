import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { install } = require('../src/compact-media-budget.js');
const cdp = require('../cdp.js');
const origin = 'http://127.0.0.1:30303';
const socketUrl = 'ws://127.0.0.1:30303/connect-websocket';
const procedure = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';

function browser(href = origin) {
  const sent = [];
  class WebSocket {
    constructor(url = socketUrl) { this.url = url; }
    send(body) { sent.push(body); }
  }
  const win = { URL, Uint8Array, DataView, WebSocket, TextEncoder, TextDecoder, Headers,
    location: { href }, fetch: (...args) => sent.push(args) };
  win.top = win;
  return { win, sent };
}

function frame(payload, fields = {}) {
  return JSON.stringify({ streamId: 'synthetic', procedure, type: 'start', stream: false,
    headers: { 'Content-Type': ['application/json'] }, payload, ...fields });
}

function grpc(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const body = Buffer.alloc(5 + data.length);
  body.writeUInt32BE(data.length, 1);
  data.copy(body, 5);
  return body;
}

const prompt = {
  cascadeId: 'synthetic', items: [{ text: 'Follow up' }], media: [{ inlineData: 'YWJj', mimeType: 'image/png' }],
  cascadeConfig: { checkpointConfig: { contextWindow: 1024, maxUserRequestMediaTokens: 600 } },
};
const compact = { ...prompt, items: [{ item: { slashCommand: { info: { name: 'compact' } } } }] };

test('compact media budget is opt-in and packaged with the runtime', () => {
  assert.equal(cdp.DEFAULT_CONFIG.compactMediaBudget, false);
  assert.equal(cdp.validateConfigEntry('compactMediaBudget', true), true);
  assert.equal(cdp.validateConfigEntry('compactMediaBudget', 'unexpected'), false);
  assert.ok(!cdp.RUNTIME_PARTS.includes('src/compact-media-budget.js'));
  assert.ok(cdp.SYNC_ROOT_FILES.includes('src/compact-media-budget.js'));
});

test('WebSocket changes only the same-origin unary conversation request', () => {
  const { win, sent } = browser();
  const socket = new win.WebSocket();
  const original = win.WebSocket.prototype.send;
  const unmodified = frame(prompt);
  socket.send(unmodified);
  const disable = install(win);
  socket.send(unmodified);
  assert.equal(sent.shift(), unmodified);
  const updated = JSON.parse(sent.shift());
  assert.deepEqual(updated, { ...JSON.parse(unmodified), payload: { ...prompt,
    cascadeConfig: { checkpointConfig: { contextWindow: 1024, maxUserRequestMediaTokens: 1 } } } });

  const untouched = [frame(compact), frame(prompt, { procedure: '/service/Other' }),
    frame(prompt, { type: 'cancel' }), frame(prompt, { stream: true }), frame({ ...prompt, cascadeConfig: null }),
    frame({ ...prompt, cascadeConfig: { checkpointConfig: [] } }), `${unmodified.slice(0, -1)}!`];
  for (const data of untouched) socket.send(data);
  assert.deepEqual(sent.splice(0), untouched);

  new win.WebSocket('ws://127.0.0.1:30304/connect-websocket').send(unmodified);
  disable();
  assert.equal(win.WebSocket.prototype.send, original);
  socket.send(unmodified);
  assert.deepEqual(sent, [unmodified, unmodified]);
});

test('gRPC-Web reframes only one valid JSON data frame and preserves request options', () => {
  const { win, sent } = browser();
  const original = win.fetch;
  const disable = install(win);
  const headers = new Headers({ 'Content-Type': 'application/grpc-web+json', 'X-Grpc-Web': '1' });
  const body = grpc(prompt);
  const init = { method: 'POST', body, headers, signal: new AbortController().signal };
  win.fetch(new URL(procedure, origin), init);
  const [, updated] = sent.shift();
  assert.equal(updated.headers, headers);
  assert.equal(updated.signal, init.signal);
  assert.equal(updated.body[0], 0);
  assert.equal(new DataView(updated.body.buffer).getUint32(1), updated.body.length - 5);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(updated.body.subarray(5))), { ...prompt,
    cascadeConfig: { checkpointConfig: { contextWindow: 1024, maxUserRequestMediaTokens: 1 } } });

  const bad = { ...init, body: body.subarray(0, -1) };
  const compressed = { ...init, body: Uint8Array.from(body) };
  compressed.body[0] = 1;
  const compaction = { ...init, body: grpc(compact) };
  const otherType = { ...init, headers: new Headers({ 'Content-Type': 'application/grpc-web+proto' }) };
  for (const untouched of [bad, compressed, compaction, otherType]) win.fetch(procedure, untouched);
  win.fetch(`http://localhost:30303${procedure}`, init);
  assert.deepEqual(sent.splice(0).map((args) => args[1]), [bad, compressed, compaction, otherType, init]);

  disable();
  assert.equal(win.fetch, original);
  win.fetch(procedure, init);
  assert.equal(sent.pop()[1], init);
});

test('leaves remote and embedded pages alone and coexists with a later wrapper', () => {
  assert.equal(install(browser('https://antigravity.google').win), null);
  const embedded = browser().win;
  embedded.top = {};
  assert.equal(install(embedded), null);

  const { win, sent } = browser();
  const disable = install(win);
  const ours = win.WebSocket.prototype.send;
  const peer = function (data) { return ours.call(this, data); };
  win.WebSocket.prototype.send = peer;
  disable();
  const data = frame(prompt);
  new win.WebSocket().send(data);
  assert.equal(win.WebSocket.prototype.send, peer);
  assert.deepEqual(sent, [data]);
});
