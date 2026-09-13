# Jarvis personal assistant

Open `/jarvis` or `/harness` for the working assistant. `/` retains the Beautiful UI component gallery. The original scripted harness remains available as a source reference, but the assistant routes no longer use it.

## Server configuration

- `OPENAI_API_KEY`: OpenAI project key with Agents read/write and Responses write access. Keep it server-side.
- `JARVIS_ACCESS_PASSWORD`: a private password of at least 16 characters. Required; the application fails closed without it. Set it in Railway service variables alongside the API key.
- `JARVIS_PUBLIC_URL`: optional canonical origin for a custom domain (for example `https://jarvis.example.com`, without a trailing slash). Railway-generated domains are detected automatically.
- `JARVIS_AGENT_MODEL`: optional; defaults to `gpt-6-astra`.

This is a single-owner personal alpha. Everyone with the password shares the same Jarvis conversations in the OpenAI project. It is not a multi-user service. Sign-in uses a signed HttpOnly SameSite cookie lasting seven days. Rotating the password invalidates existing cookies. Login throttling is process-local; use an external rate limiter before scaling beyond the current single service instance or offering public registration.

No credentials are sent to the browser or agent sandbox. Do not set `OPENAI_BASE_URL` in production; the integration test uses it only for its local API fixture.

## Implemented

- Managed OpenAI-hosted sessions with persisted conversation IDs and a conversation selector.
- Initial tasks and follow-up messages; no scripted answers.
- Real file attachments at creation or on subsequent turns (5 MiB each, 10 MiB combined, at most 10 files).
- Downloadable, immutable artifacts from `/workspace/outputs`.
- Actual task status and cancellation, with saved-item recovery after browser refresh.
- Session and artifact access restricted to authenticated requests and Jarvis-tagged sessions.

Progress is refreshed from persisted session items, not token-streamed yet. The view displays the latest 100 items and the first 100 artifacts, with an explicit notice when more exist; the agent retains earlier conversation context. Session listing is paginated. Refreshes poll every four seconds during work, less often when idle or hidden. Closing a tab does not cancel a task. Use Stop task to send an explicit cancellation and wait for the resulting status.

Hosted workspaces can expire. Saved conversation items and published artifacts survive workspace expiry, but expired live input files may need uploading into a new conversation. A timed-out creation request may have started work: inspect the conversation list before resending. Follow-up submissions use the API's idempotency header; the app never automatically retries writes.

## Verification

Use Node 22.6+ (or Node 24):

```sh
npm ci
npm run test:jarvis
npm run build
npm run test:jarvis:integration
```

The integration test starts a local OpenAI API fixture and the production Next server on port 3197. It exercises authentication, origin checks, session isolation, hosted creation, file payloads, saved history, follow-up, cancellation and actual download bytes. It does **not** prove real OpenAI access or inference. `node tests/jarvis.integration.mjs --serve` keeps that fixture running for browser checks; its credentials and responses are test-only.

For the live acceptance check, sign in on Railway, upload a small non-sensitive CSV, ask Jarvis to calculate totals and write `/workspace/outputs/summary.csv`, download and inspect the content, refresh the page, then send a follow-up in the same conversation. Verify failed and cancelled outcomes separately. A successful build or a configured key alone does not establish Agents API access.

## Next milestones

GPT-Live-1 client delegation will connect voice to these same sessions. A separate Mac companion is still needed for local files and application control. OAuth connectors, per-user accounts, full-history pagination, token streaming, and desktop permissions are not implemented in this milestone.

Official contracts: [sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions), [files and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files), [GPT-Live delegation](https://developers.openai.com/api/docs/guides/live-delegation).
