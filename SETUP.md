# Setup

## Prerequisites

Install Node.js 20.19+ or 22.12+ and npm 10+. The project uses Vite 7, React 19, TypeScript 5.9, React Router 7, Zustand 5, Tailwind CSS 3.4, Lucide React, TipTap 3.32.2, and Vitest 4.1.12. TipTap packages are pinned to one version. Test dependencies are pinned in `package.json`.

## Install and run

```sh
npm install
npm run dev
npm run test
npm run build
```

The Vite server prints its local URL. `npm run build` runs TypeScript project checks, builds the frontend, and compiles the Node service into `dist/`.

## AI summarization (optional)

The editor's AI Summary panel needs a Groq API key. Everything else in TSG runs without one.

1. Create a key at <https://console.groq.com>.
2. Copy `.env.example` to `.env` and set `GROQ_API_KEY`. `.env` is gitignored; never commit a key.
3. Run `npm start`; the frontend, signaling, health endpoint, and summary API share one port.

For local development, `npm run dev` serves the frontend and summary API through Vite. To enable
peer signaling alongside it, run `npm run dev:all` and set `VITE_SIGNALING_URL=ws://localhost:4444`
in the frontend environment. The production default uses the current page's host and protocol.

| Variable | Process | Purpose |
| --- | --- | --- |
| `PORT` | Node service | Service port. Defaults to 4444. |
| `GROQ_API_KEY` | Node service | Provider key. Without it the route answers 503 and the panel says summaries are not configured. |
| `GROQ_MODEL` | Node service | Model override. Defaults to `openai/gpt-oss-20b`. |
| `WS_ALLOWED_ORIGINS` | Node service | Optional comma-separated browser origins permitted to connect over WebSocket. |
| `VITE_SUMMARY_URL` | frontend | Optional summary endpoint override. Defaults to the relative `/api/summarize`. |
| `VITE_SIGNALING_URL` | frontend | Optional signaling URL override. Defaults to the page's host and protocol. |
| `VITE_ICE_SERVERS` | frontend | Optional JSON array overriding the default public STUN server. |

Check the service with `curl http://localhost:4444/health`; it reports whether a key is configured
without revealing it.

Privacy: clicking AI Summary sends that document's text to Groq, a third party, for processing.
Nothing is sent until the click, the service stores no document content and logs only a character
count, and the resulting summary stays in the requesting browser unless the user inserts it. Do not
enable this for documents that may not leave your infrastructure.

## Current limitations

The landing page and dashboard are implemented. Document metadata and rich-text content save in separate IndexedDB stores for this origin; browser storage and transaction errors are surfaced. On first open, a one-time migration imports Phase 2 localStorage documents and retains the source data. TipTap Collaboration edits a per-document Y.Doc persisted by y-indexeddb. The editor supports headings, paragraphs, bold, italic, underline, strike, text alignment, lists/checklists, safe links, tables, blockquotes, code blocks, Yjs-backed undo/redo, and word/character counts.

AI summarization is optional and cloud-based: it requires internet access and a Groq key, is
disabled while the browser is offline, and has no local-inference path. It shares the Node web
service process with signaling and is not required for any other feature.

There is no peer networking/signaling, profile identity, service worker, or installable/offline app shell yet. Local Yjs CRDT convergence is tested in independent in-memory replicas; this does not establish network collaboration. The app cannot promise offline application reopening.
