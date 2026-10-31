# Touching Some Grass (TSG)

**Collaborate anywhere. Create everywhere. Even offline.**

TSG is an offline-first collaborative document editor. Rich text is backed by per-document Yjs documents persisted with y-indexeddb; metadata and content projections use IndexedDB. Peers exchange updates directly over y-webrtc/WebRTC data channels. The lightweight signaling service relays WebRTC setup messages only and does not store document content. Local edits are retained while peers are disconnected, and reconnecting replicas exchange CRDT updates until their Yjs state vectors match. Concurrent overlapping text edits are retained as alternatives and can be resolved in the editor.

## Project status

Phases 1–6 have implementation and verification recorded in `PROGRESS.md`. The app includes the responsive landing page, dashboard, TipTap editor, local document CRUD/autosave, Yjs CRDT state, IndexedDB persistence, y-webrtc P2P transport, Awareness, offline-edit recovery, a state-vector based synchronization indicator, block-level conflict review with rich-text alternatives, and named document version history with full-format restore and synchronized deletion of saved snapshots. Independent Chromium contexts verify loopback P2P, browser-process restart recovery, and short offline/reconnect scenarios. The app does not yet provide PWA offline app-shell reopening, weeks-long offline guarantees, authenticated identity, comments/activity, export/settings. Conflict grouping is by logical block and causality, not a general semantic merge for all rich-text operations; see `CRDT_EXPLANATION.md`. Cross-network connectivity is not guaranteed; some networks need TURN.

Automated coverage exercises IndexedDB, TipTap–Yjs, local CRDT convergence, the signaling protocol, and independent-browser WebRTC sync. See [PROGRESS.md](./PROGRESS.md) for actual test results and remaining milestones. The project is not yet a PWA-ready or production-deployed application.

See [SETUP.md](./SETUP.md) for local setup and [ARCHITECTURE.md](./ARCHITECTURE.md) for the intended system boundaries.
Milestone-by-milestone notes are in [PROGRESS.md](./PROGRESS.md).

## Requirements

- Node.js 20.19+ or 22.12+
- npm 10+

## Commands

```sh
npm install
npm run dev
npm run dev:all
npm run signaling
npm run llm
npm test
npm run test:e2e
npm run typecheck:integration
npm run build
npm run signaling:build
npm run preview
```

## AI summarization

An optional **AI Summary** panel in the editor summarizes the open document on request. It is
additive: the editor, CRDT, persistence, peer sync, conflict review and version history all work
exactly as before with the feature unused or unconfigured.

- **Provider and model:** Groq, `openai/gpt-oss-20b` by default, overridable with `GROQ_MODEL`.
- **Service:** `server/index.js`, started with `npm run llm`, listening on port 4455 by default.
  It is a separate process from the WebRTC signaling service, so an LLM outage, a missing key or a
  provider rate limit cannot affect document synchronization. Signaling never needs the API key.
- **Key handling:** `GROQ_API_KEY` is read only by that service. It is never bundled, never sent to
  the browser and never written to a response. `.env` is gitignored; `.env.example` is the template.
- **What is sent:** only when the user clicks AI Summary, and only the text of the document they
  have open, extracted from the live editor. No document content is stored by the service, and only
  a character count is logged. Groq processes the text as a third party.
- **Summaries are private to the requester.** The result lives in local React state, never in the
  Y.Doc, so collaborators neither see it nor receive any update while it is generated. Inserting a
  summary into the document is an explicit, separate click; only then does it sync like typed text.
- **Offline:** the Summarize button is disabled with an explanatory tooltip when the browser is
  offline. Editing, local persistence and peer sync are unaffected.

Set `VITE_SUMMARY_URL` if the browser should reach the service at some address other than the
same-origin `/api/summarize` path that `npm run dev` and a production reverse proxy provide.

## Roadmap

1. Foundation: design system, landing page, dashboard shell.
2. Editor: TipTap, formatting, browser-local document CRUD and autosave (complete).
3. Local persistence: IndexedDB document metadata/content, safe legacy migration, and y-indexeddb update-store foundation (complete).
4. CRDT: Yjs integration with TipTap and convergence tests (complete).
5. P2P: y-webrtc, signaling-only service, Awareness, provider lifecycle and local browser transport tests (implemented; see Phase 5 verification in `PROGRESS.md`).
6. Offline sync: local recovery, ordered reconnect tests, state-vector convergence status, and overlapping-edit review (implemented; test-duration limits are documented).
7. PWA: application shell caching and offline reopen.
8. Advanced features: comments, activity, settings, export, and stronger conflict classification.
   AI document summarization is implemented as an optional, separately deployed service.
9. Broader fault-injection, performance and cross-network TURN tests.
10. Deployment and operational hardening.

## Documents

- [Architecture](./ARCHITECTURE.md)
- [P2P networking](./P2P_NETWORKING.md)
- [CRDT notes](./CRDT_EXPLANATION.md)
- [Offline sync](./OFFLINE_SYNC.md)
- [Testing](./TESTING.md)
- [Deployment](./DEPLOYMENT.md)
