import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { COOKIE, MAX_AGE, passwordConfigured, matchesPassword, issueToken, validToken } from '@/lib/jarvis/auth';
import { APP_TAG, client, belongsToJarvis, instructions, summary } from '@/lib/jarvis/agent';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, safeFilename, messageText, validId } from '@/lib/jarvis/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const loginAttempts = new Map<string, { count: number; until: number }>();
async function limitedBody(req: NextRequest, max: number) {
  if (Number(req.headers.get('content-length')) > max) throw new HttpError(413, 'Request is too large.');
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function body(req: NextRequest, max = 40_000) {
  try { return JSON.parse(Buffer.from(await limitedBody(req, max)).toString()); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Invalid request.'); }
}
async function handle(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  try {
    const path = (await context.params).path ?? [];
    // Railway terminates TLS before Next; use its configured public origin.
    const publicOrigin = process.env.JARVIS_PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : req.nextUrl.origin);
    if (req.method !== 'GET' && req.headers.get('origin') !== publicOrigin) {
      throw new HttpError(403, 'Request origin is not allowed.');
    }
    if (path.join('/') === 'auth') {
      if (req.method === 'GET') return json({ authenticated: validToken(req.cookies.get(COOKIE)?.value ?? ''), configured: passwordConfigured() && !!process.env.OPENAI_API_KEY });
      if (req.method === 'DELETE') {
        const res = json({ ok: true }); res.cookies.set(COOKIE, '', { maxAge: 0, path: '/' }); return res;
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      if (!passwordConfigured()) throw new HttpError(503, 'Jarvis sign-in is not configured yet.');
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown';
      const now = Date.now();
      for (const [key, value] of loginAttempts) if (value.until < now) loginAttempts.delete(key);
      const attempts = loginAttempts.get(ip) ?? { count: 0, until: now + 60_000 };
      if (attempts.count >= 5 || loginAttempts.size > 10000) throw new HttpError(429, 'Too many attempts. Try again in one minute.');
      attempts.count++; loginAttempts.set(ip, attempts);
      const data = await body(req);
      if (typeof data.password !== 'string' || !matchesPassword(data.password)) throw new HttpError(401, 'Incorrect password.');
      loginAttempts.delete(ip);
      const res = json({ ok: true });
      res.cookies.set(COOKIE, issueToken(), { httpOnly: true, secure: publicOrigin.startsWith('https:'), sameSite: 'strict', maxAge: MAX_AGE, path: '/' });
      return res;
    }
    if (!validToken(req.cookies.get(COOKIE)?.value ?? '')) throw new HttpError(401, 'Sign in to Jarvis.');
    const api = client();
    if (path[0] !== 'sessions') throw new HttpError(404, 'Not found.');
    if (path.length === 1 && req.method === 'GET') {
      const after = req.nextUrl.searchParams.get('after') ?? undefined;
      if (after && !validId(after)) throw new HttpError(400, 'Invalid cursor.');
      const page = await api.beta.agents.sessions.list({ limit: 100, order: 'desc', after });
      return json({ sessions: page.data.filter(belongsToJarvis).map(summary), after: page.hasNextPage() ? page.data.at(-1)?.id : null });
    }
    if (path.length === 1 && req.method === 'POST') {
      const data = await body(req, 14 * 1024 * 1024);
      const text = messageText(data.text);
      const uploads = data.files ?? [];
      if (!Array.isArray(uploads) || uploads.length > 10) throw new HttpError(400, 'Choose at most 10 files.');
      let total = 0;
      const files = uploads.map((file: { name?: unknown; data?: unknown }) => {
        if (typeof file?.name !== 'string' || typeof file?.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new HttpError(400, 'Invalid file.');
        const bytes = Buffer.from(file.data, 'base64'); total += bytes.length;
        if (bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new HttpError(413, 'Files must be at most 5 MiB each and 10 MiB combined.');
        return { type: 'inline' as const, path: `/workspace/uploads/${randomUUID()}-${safeFilename(file.name)}`, data: file.data };
      });
      const events = await api.beta.agents.sessions.create({
        agent: { model: process.env.JARVIS_AGENT_MODEL || 'gpt-6-astra', instructions },
        environment: { type: 'openai_hosted', files },
        metadata: { app: APP_TAG, title: text.slice(0, 100) },
        input: text + (files.length ? '\n\nUploaded files:\n' + files.map(f => f.path).join('\n') : ''), stream: true,
      });
      try {
        for await (const event of events) {
          if (event.type === 'agent.session.created') return json({ session: summary(event.session) }, 201);
          if (event.type === 'agent.session.failed' || event.type === 'error') throw new HttpError(502, 'Agent could not start. Check conversation history before retrying.');
        }
      } finally { events.controller.abort(); }
      throw new HttpError(502, 'Connection ended before a session was received. Check conversation history before retrying.');
    }
    const id = path[1];
    if (!id || !validId(id)) throw new HttpError(404, 'Conversation not found.');
    const session = await api.beta.agents.sessions.retrieve(id);
    if (!belongsToJarvis(session)) throw new HttpError(404, 'Conversation not found.');
    if (path.length === 2 && req.method === 'GET') {
      const [items, turns, artifacts] = await Promise.all([
        api.beta.agents.sessions.items.list(id, { limit: 100, order: 'desc' }),
        api.beta.agents.sessions.turns.list(id, { limit: 1, order: 'desc' }),
        api.beta.agents.sessions.artifacts.list(id, { limit: 100 }),
      ]);
      return json({ session: summary(session), error: session.error, environment: { type: session.environment.type },
        items: [...items.data].reverse(), hasOlderItems: items.hasNextPage(), turn: turns.data[0] ?? null,
        artifacts: artifacts.data, hasMoreArtifacts: artifacts.hasNextPage() });
    }
    if (path.length === 2 && req.method === 'DELETE') {
      await api.beta.agents.sessions.delete(id); return json({ ok: true });
    }
    if (path[2] === 'messages' && path.length === 3 && req.method === 'POST') {
      const data = await body(req); const text = messageText(data.text);
      if (typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId)) throw new HttpError(400, 'Invalid message identifier.');
      if (session.status !== 'idle') throw new HttpError(409, 'Wait for the current task or stop it before sending another message.');
      await api.beta.agents.sessions.events.create(id, { 'Idempotency-Key': data.requestId,
        events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
      return json({ ok: true });
    }
    if (path[2] === 'cancel' && path.length === 3 && req.method === 'POST') {
      await api.beta.agents.sessions.events.create(id, { events: [{ type: 'agent.session.input.cancel' }] });
      return json({ ok: true });
    }
    if (path[2] === 'files' && path.length === 3 && req.method === 'POST') {
      if (session.status !== 'idle') throw new HttpError(409, 'Wait for the current task before adding files.');
      if (session.environment.type !== 'openai_hosted') throw new HttpError(409, 'This conversation has no hosted workspace.');
      const bytes = await limitedBody(req, MAX_TOTAL_BYTES + 100_000);
      const form = await new Response(bytes, { headers: { 'Content-Type': req.headers.get('content-type') ?? '' } }).formData();
      const files = form.getAll('files');
      if (!files.length || files.length > 10 || files.some(f => !(f instanceof File))) throw new HttpError(400, 'Choose between 1 and 10 files.');
      let total = 0;
      for (const entry of files) { const f = entry as File; total += f.size; if (f.size > MAX_FILE_BYTES) throw new HttpError(413, 'Each file must be 5 MiB or smaller.'); }
      if (total > MAX_TOTAL_BYTES) throw new HttpError(413, 'Uploads must total 10 MiB or less.');
      const uploaded: { name: string; path: string }[] = [];
      for (const entry of files) {
        const f = entry as File; const destination = `/workspace/uploads/${randomUUID()}-${safeFilename(f.name)}`;
        await api.beta.agents.environments.files.create(session.environment.id, { type: 'inline', path: destination, data: Buffer.from(await f.arrayBuffer()).toString('base64') });
        uploaded.push({ name: f.name, path: destination });
      }
      return json({ files: uploaded });
    }
    if (path[2] === 'artifacts' && path.length === 4 && req.method === 'GET') {
      if (!validId(path[3])) throw new HttpError(404, 'Artifact not found.');
      const artifact = await api.beta.agents.sessions.artifacts.retrieve(path[3], { session_id: id });
      const content = await api.beta.agents.sessions.artifacts.content(path[3], { session_id: id });
      return new Response(content.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeFilename(artifact.path.split('/').at(-1) ?? 'download')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    throw new HttpError(404, 'Not found.');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof OpenAI.APIError) {
      // Never return provider response bodies, request headers or credentials.
      const status = error.status ?? 502;
      const message = status === 401 || status === 403 ? 'OpenAI rejected access. Check the API key, project permissions and Agents API access.' : status === 429 ? 'OpenAI usage or rate limit reached. Check billing and try again later.' : status === 404 ? 'The requested OpenAI resource or API is unavailable.' : status === 409 ? 'The workspace is busy or unavailable. Refresh before retrying.' : 'OpenAI could not complete this request. Refresh conversation history before retrying.';
      return json({ error: message }, status >= 500 ? 502 : status);
    }
    if (error instanceof Error && error.message.startsWith('Enter a message')) return json({ error: error.message }, 400);
    return json({ error: 'Request failed. Refresh conversation history before retrying.' }, 502);
  }
}
export { handle as GET, handle as POST, handle as DELETE };
