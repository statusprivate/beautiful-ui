import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// A local API double validates transport and permission boundaries without live credentials.
const requests = [];
const sessions = new Map();
const session = (id, app = 'jarvis-personal-v1') => ({ id, object: 'agent.session', agent: {}, created_at: 1800000000, last_active_at: 1800000000, metadata: { app, title: 'File test' }, environment: { type: 'openai_hosted', id: 'env_test' }, status: 'idle', required_actions: [], error: null });
sessions.set('sess_test', session('sess_test'));
sessions.set('sess_foreign', session('sess_foreign', 'other-app'));
const page = data => ({ object: 'list', data, has_more: false, first_id: data[0]?.id, last_id: data.at(-1)?.id });
const provider = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString(); const data = raw ? JSON.parse(raw) : null;
  requests.push({ url: req.url, method: req.method, data });
  res.setHeader('content-type', 'application/json');
  const url = new URL(req.url, 'http://localhost'); const path = url.pathname;
  if (path === '/v1/agents/sessions' && req.method === 'GET') return res.end(JSON.stringify(page([...sessions.values()])));
  if (path === '/v1/agents/sessions' && req.method === 'POST') {
    const created = session('sess_created'); sessions.set(created.id, created);
    res.setHeader('content-type', 'text/event-stream');
    return res.end(`data: ${JSON.stringify({ type: 'agent.session.created', session: created })}\n\ndata: [DONE]\n\n`);
  }
  if (path.endsWith('/events') && req.method === 'POST') { res.statusCode = 204; return res.end(); }
  if (path === '/v1/agents/environments/env_test/files' && req.method === 'POST') return res.end(JSON.stringify({ path: data.path, size_bytes: Buffer.from(data.data, 'base64').length }));
  if (path.endsWith('/items')) return res.end(JSON.stringify(page([{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture answer: 42' }], status: 'completed', turn_id: 'turn_test' }])));
  if (path.endsWith('/turns')) return res.end(JSON.stringify(page([{ id: 'turn_test', status: 'completed' }])));
  if (path.endsWith('/artifacts')) return res.end(JSON.stringify(page([{ id: 'artifact_test', path: '/workspace/outputs/report.txt', size_bytes: 11, turn_id: 'turn_test' }])));
  if (path.endsWith('/artifacts/artifact_test/content')) { res.setHeader('content-type', 'application/octet-stream'); return res.end('real bytes\n'); }
  if (path.endsWith('/artifacts/artifact_test')) return res.end(JSON.stringify({ id: 'artifact_test', path: '/workspace/outputs/report.txt' }));
  const id = path.split('/').at(-1);
  if (sessions.has(id)) return res.end(JSON.stringify(sessions.get(id)));
  res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'Fixture not found' } }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerPort = provider.address().port;
const port = 3197;
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
  env: { ...process.env, OPENAI_API_KEY: 'local-test-fixture', OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, JARVIS_ACCESS_PASSWORD: 'local-test-password-12345' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
const base = `http://localhost:${port}`;
let cookie = '';
async function call(path, method = 'GET', data, origin = base) {
  return fetch(`${base}/api/jarvis/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin } : {}), ...(data && !(data instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: data instanceof FormData ? data : data ? JSON.stringify(data) : undefined });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await call('auth'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(ready, output);
  assert.equal((await call('sessions')).status, 401);
  assert.equal(requests.length, 0, 'unauthenticated requests must never reach OpenAI');
  assert.equal((await call('auth', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await call('auth', 'POST', { password: 'local-test-password-12345' }, 'https://evil.example')).status, 403);
  const login = await call('auth', 'POST', { password: 'local-test-password-12345' });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /httponly/i);
  const list = await (await call('sessions')).json();
  assert.equal(list.sessions.length, 1); assert.equal(list.sessions[0].id, 'sess_test');
  assert.equal((await call('sessions/sess_foreign')).status, 404);
  assert.equal((await call('sessions/sess_foreign/artifacts/artifact_test')).status, 404);
  assert.equal((await call('sessions', 'POST', { text: ' ' })).status, 400);
  const created = await call('sessions', 'POST', { text: 'Analyse this file', files: [{ name: '../../data.csv', data: Buffer.from('a,b\n1,2').toString('base64') }] });
  assert.equal(created.status, 201);
  const creation = requests.find(r => r.method === 'POST' && r.url === '/v1/agents/sessions');
  assert.equal(creation.data.environment.type, 'openai_hosted');
  assert.match(creation.data.environment.files[0].path, /^\/workspace\/uploads\/[a-f0-9-]+-_.*data.csv$/);
  assert.match(creation.data.input, /Uploaded files/);
  const snapshot = await (await call('sessions/sess_test')).json();
  assert.equal(snapshot.items[0].content[0].text, 'Fixture answer: 42'); assert.equal(snapshot.turn.status, 'completed');
  assert.equal((await call('sessions/sess_test/messages', 'POST', { text: 'Continue', requestId: '11111111-1111-4111-8111-111111111111' })).status, 200);
  const form = new FormData(); form.append('files', new File(['file bytes'], '../../input.txt'));
  assert.equal((await call('sessions/sess_test/files', 'POST', form)).status, 200);
  assert.equal(Buffer.from(requests.find(r => r.url.includes('/environments/')).data.data, 'base64').toString(), 'file bytes');
  const download = await call('sessions/sess_test/artifacts/artifact_test');
  assert.equal(await download.text(), 'real bytes\n'); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal((await call('sessions/sess_test/cancel', 'POST', {})).status, 200);
  assert.ok(requests.some(r => r.data?.events?.[0]?.type === 'agent.session.input.cancel'));
  assert.equal((await call('auth', 'DELETE')).status, 200);
  console.log('PASS: auth, CSRF, session isolation, hosted creation with files, saved history, follow-up, upload bytes, artifact bytes, cancellation, logout');
  if (process.argv.includes('--serve')) {
    console.log(`Browser fixture running at ${base}/jarvis`);
    await new Promise(resolve => process.on('SIGTERM', resolve));
  }
} finally { child.kill('SIGTERM'); provider.closeAllConnections(); provider.close(); }
