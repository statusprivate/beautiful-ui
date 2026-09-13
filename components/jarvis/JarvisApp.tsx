"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Attachment, ArrowUp, Download, LogOut, Refresh, Xmark } from 'iconoir-react';
import { Button } from '@/components/atoms/Button';
import { StatusPill } from '@/components/atoms/StatusPill';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '@/lib/jarvis/validation';

type Session = { id: string; title: string; status: string };
type Item = { id: string | null; type: string; role?: string; status?: string; phase?: string; content?: { type: string; text?: string }[] };
type Snapshot = { session: Session; items: Item[]; turn: { id: string; status: string; error?: { message?: string } } | null; error?: string; artifacts: { id: string; path: string; size_bytes: number; turn_id: string }[]; hasOlderItems: boolean; hasMoreArtifacts: boolean };
async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api/jarvis/${path}`, { cache: 'no-store', ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
const post = (value: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
function fileBase64(file: File): Promise<{ name: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] });
    reader.readAsDataURL(file);
  });
}

export default function JarvisApp() {
  const [auth, setAuth] = useState<'loading' | 'locked' | 'ready'>('loading');
  const [configured, setConfigured] = useState(true);
  const [password, setPassword] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const active = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const running = pending || snapshot?.session.status === 'in_progress' || snapshot?.session.status === 'requires_action' || ['queued', 'in_progress', 'waiting'].includes(snapshot?.turn?.status ?? '');

  const loadSessions = useCallback(async (cursor?: string) => {
    const data = await request(`sessions${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`);
    setSessions(previous => cursor ? [...previous, ...data.sessions] : data.sessions);
    setAfter(data.after);
  }, []);
  const refresh = useCallback(async (id: string) => {
    const data: Snapshot = await request(`sessions/${id}`);
    if (active.current === id) setSnapshot(data);
    return data;
  }, []);
  function select(id: string | null) {
    active.current = id; setSelected(id); setSnapshot(null); setError(''); setNotice(''); setPending(false); setFiles([]); setText('');
    if (id) window.history.replaceState(null, '', `?conversation=${encodeURIComponent(id)}`);
    else window.history.replaceState(null, '', window.location.pathname);
  }
  useEffect(() => {
    request('auth').then(data => { setConfigured(data.configured); setAuth(data.authenticated ? 'ready' : 'locked'); }).catch(e => { setError(e.message); setAuth('locked'); });
  }, []);
  useEffect(() => {
    if (auth !== 'ready') return;
    loadSessions().catch(e => setError(e.message));
    const id = new URLSearchParams(window.location.search).get('conversation');
    if (id) select(id);
  }, [auth, loadSessions]);
  useEffect(() => {
    if (!selected || auth !== 'ready') return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let delay = 4000;
      try {
        const data = await refresh(selected);
        if (!pending && data.session.status === 'idle' && ['completed', 'failed', 'cancelled'].includes(data.turn?.status ?? '')) delay = 30000;
        if (document.hidden) delay = 30000;
      } catch (e) { if (!disposed) setError((e as Error).message); delay = 15000; }
      if (!disposed) timer = setTimeout(tick, delay);
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [selected, auth, refresh, pending]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [snapshot?.items.length]);

  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await request('auth', post({ password })); setPassword(''); setAuth('ready'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault(); if (!text.trim() || busy || running) return;
    setBusy(true); setError(''); setNotice('');
    const id = selected; let submitted = false;
    try {
      if (!id) {
        const data = await request('sessions', post({ text, files: await Promise.all(files.map(fileBase64)) }));
        submitted = true; select(data.session.id); setSessions(previous => [data.session, ...previous]);
        await refresh(data.session.id);
      } else {
        let message = text;
        if (files.length) {
          const form = new FormData(); files.forEach(file => form.append('files', file));
          const data = await request(`sessions/${id}/files`, { method: 'POST', body: form });
          message += '\n\nUploaded files:\n' + data.files.map((f: { path: string }) => f.path).join('\n');
        }
        await request(`sessions/${id}/messages`, post({ text: message, requestId: crypto.randomUUID() }));
        submitted = true; setPending(true); setText(''); setFiles([]);
        // Polling persisted items recovers output even if the tab closes mid-task.
        const data = await refresh(id);
        if (data.session.status !== 'idle') setPending(false);
        setNotice('Message sent. Task status will update shortly.');
      }
    } catch (e) {
      setError(`${(e as Error).message}${submitted ? ' Your message was submitted.' : ' Check history before resending.'}`);
      await loadSessions().catch(() => {});
    } finally { setBusy(false); }
  }
  useEffect(() => {
    if (pending && snapshot && (snapshot.session.status !== 'idle' || snapshot.items.some(item => item.status === 'in_progress'))) setPending(false);
  }, [pending, snapshot]);
  // An accepted message can complete between polls; a changed turn also clears pending.
  const priorTurn = useRef<string | null>(null);
  useEffect(() => {
    if (snapshot?.turn?.id && snapshot.turn.id !== priorTurn.current) { priorTurn.current = snapshot.turn.id; setPending(false); }
  }, [snapshot?.turn?.id]);

  if (auth === 'loading') return <main className="min-h-dvh grid place-items-center text-ink-2">Opening Jarvis…</main>;
  if (auth === 'locked') return <main className="min-h-dvh grid place-items-center bg-canvas p-6">
    <form onSubmit={login} className="w-full max-w-sm rounded-3xl bg-surface p-8 shadow-card space-y-5">
      <h1 className="text-3xl font-semibold text-ink">Jarvis</h1>
      <p className="text-sm text-ink-2">Your private workspace for conversations, files and getting things done.</p>
      {!configured && <p role="status" className="text-sm text-orange">Server setup is not complete. Add the API key and a sign-in password in Railway.</p>}
      <label className="block text-sm text-ink">Password<input name="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required className="mt-2 w-full rounded-xl bg-field p-3 outline-accent" /></label>
      {error && <p role="alert" className="text-sm text-red">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy || !configured} className="w-full">{busy ? 'Signing in…' : 'Open Jarvis'}</Button>
    </form>
  </main>;

  const state = snapshot?.turn?.status ?? snapshot?.session.status;
  return <main className="flex h-dvh flex-col md:flex-row overflow-hidden bg-canvas text-ink">
    <aside className="w-full md:w-64 shrink-0 border-b md:border-b-0 md:border-r border-line bg-page p-4 md:flex md:flex-col">
      <div className="flex items-center justify-between mb-4"><a href="/jarvis" className="text-xl font-semibold tracking-tight">Jarvis</a><Button size="xs" variant="quiet" aria-label="Sign out" onClick={async () => { await request('auth', { method: 'DELETE' }); setAuth('locked'); setSnapshot(null); setSessions([]); select(null); }}><LogOut width={17} height={17} /></Button></div>
      <Button onClick={() => select(null)} disabled={busy} className="w-full justify-start"><Plus width={17} height={17} />New conversation</Button>
      <nav aria-label="Conversations" className="mt-4 max-h-32 md:max-h-none md:flex-1 overflow-y-auto space-y-1">
        {sessions.map(session => <button key={session.id} disabled={busy} onClick={() => select(session.id)} className={`block w-full truncate rounded-xl px-3 py-2 text-left text-sm hover:bg-hover ${selected === session.id ? 'bg-hover-2' : 'text-ink-2'}`}>{session.title}</button>)}
        {after && <Button size="xs" onClick={() => loadSessions(after).catch(e => setError(e.message))}>Load older conversations</Button>}
      </nav>
      <p className="hidden md:block mt-5 text-xs text-ink-3">Files run in a hosted workspace.<br />Mac control and voice come next.</p>
    </aside>
    <section className="min-w-0 flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line bg-page/60 px-5 py-4">
        <span className="truncate text-sm font-medium">{snapshot?.session.title || 'New conversation'}</span>
        <div className="flex shrink-0 items-center gap-2">
          {state && <StatusPill tone={state === 'failed' ? 'red' : state === 'completed' ? 'green' : 'neutral'}>{pending ? 'Starting' : state.replaceAll('_', ' ')}</StatusPill>}
          {selected && <Button size="xs" variant="quiet" aria-label="Refresh conversation" onClick={() => refresh(selected).then(() => setError('')).catch(e => setError(e.message))}><Refresh width={16} height={16} /></Button>}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-8" aria-live="polite">
        <div className="max-w-3xl mx-auto space-y-6">
          {!selected && <div className="py-12 md:py-24"><h1 className="text-3xl md:text-4xl font-medium tracking-tight">What shall we work on?</h1><p className="mt-4 max-w-lg text-ink-2">Ask a question, analyse a file, or create something you can download.</p><div className="flex flex-wrap gap-2 mt-7">{['Create a simple project plan as a CSV', 'Help me analyse an uploaded file'].map(prompt => <Button key={prompt} onClick={() => setText(prompt)}>{prompt}</Button>)}</div></div>}
          {selected && !snapshot && <p className="text-ink-2">Loading conversation…</p>}
          {snapshot?.hasOlderItems && <p className="text-xs text-ink-2">Showing the latest 100 saved items. Earlier context remains with the agent.</p>}
          {snapshot?.items.map((item, index) => item.type === 'message' ? <article key={item.id ?? index} className={item.role === 'user' ? 'ml-auto max-w-[90%] w-fit rounded-2xl bg-surface px-5 py-4 shadow-hairline' : 'py-2'}>
            <p className="text-xs font-medium text-ink-3 mb-2">{item.role === 'user' ? 'You' : 'Jarvis'}{item.phase === 'commentary' ? ' · working' : ''}</p>
            <div className="text-sm md:text-[15px] leading-7 whitespace-pre-wrap break-words">{item.content?.map(part => part.text ?? '').join('\n')}</div>
          </article> : item.type === 'reasoning' ? null : <div key={item.id ?? index} className="text-xs text-ink-2 border-l-2 border-line-strong pl-3">{item.type.replaceAll('_', ' ')}{item.status ? ` · ${item.status}` : ''}</div>)}
          {snapshot?.artifacts.length ? <section aria-label="Downloads" className="rounded-2xl bg-surface p-5 shadow-card"><h2 className="text-sm font-medium mb-3">Downloads</h2><div className="space-y-2">{snapshot.artifacts.map(artifact => <a className="flex items-center gap-3 rounded-lg p-2 hover:bg-hover text-sm" key={artifact.id} href={`/api/jarvis/sessions/${selected}/artifacts/${artifact.id}`}><Download width={18} height={18} /><span className="break-all">{artifact.path.split('/').at(-1)}</span><span className="ml-auto shrink-0 text-xs text-ink-3">{Math.ceil(artifact.size_bytes / 1024)} KB</span></a>)}</div>{snapshot.hasMoreArtifacts && <p className="text-xs text-ink-2">Showing the first 100 artifacts.</p>}</section> : null}
          {(snapshot?.error || snapshot?.turn?.error) && <p role="alert" className="text-sm text-red">{snapshot.error || snapshot.turn?.error?.message || 'The task failed.'}</p>}
          <div ref={bottom} />
        </div>
      </div>
      <div className="px-4 pb-4 md:px-8 md:pb-6">
        <form onSubmit={send} className="max-w-3xl mx-auto rounded-3xl bg-surface p-4 shadow-card">
          {error && <p role="alert" className="text-sm text-red mb-3">{error}</p>}
          {notice && <p role="status" className="text-xs text-ink-2 mb-2">{notice}</p>}
          {files.length > 0 && <div className="flex flex-wrap gap-2 mb-3">{files.map((file, index) => <span className="flex items-center gap-1 text-xs rounded-lg bg-inset p-2" key={`${file.name}-${index}`}>{file.name}<button type="button" disabled={busy} aria-label={`Remove ${file.name}`} onClick={() => setFiles(list => list.filter((_, i) => i !== index))}><Xmark width={14} height={14} /></button></span>)}</div>}
          <textarea aria-label="Message Jarvis" placeholder="Message Jarvis…" value={text} onChange={e => setText(e.target.value)} maxLength={32000} rows={3} disabled={busy} className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-ink-3" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
          <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Button type="button" size="xs" variant="quiet" aria-label="Attach files" disabled={busy || !!running} onClick={() => input.current?.click()}><Attachment width={18} height={18} /></Button><span className="text-xs text-ink-3">5 MiB per file · 10 MiB total</span></div>
            {running ? <Button type="button" size="sm" disabled={busy} onClick={async () => { if (!selected) return; setBusy(true); try { await request(`sessions/${selected}/cancel`, post({})); setNotice('Stop requested. Waiting for confirmation.'); setPending(false); await refresh(selected); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Stop task</Button> : <Button type="submit" variant="primary" size="sm" aria-label="Send message" disabled={busy || !text.trim()}>{busy ? 'Sending…' : <ArrowUp width={18} height={18} />}</Button>}
          </div>
          <input ref={input} type="file" multiple hidden onChange={e => {
            const next = [...files, ...Array.from(e.target.files ?? [])]; e.target.value = '';
            if (next.length > 10 || next.some(f => f.size > MAX_FILE_BYTES) || next.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) { setError('Choose up to 10 files, at most 5 MiB each and 10 MiB total.'); return; }
            setFiles(next); setError('');
          }} />
        </form>
      </div>
    </section>
  </main>;
}
