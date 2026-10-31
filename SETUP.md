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

The Vite server prints its local URL. `npm run build` runs TypeScript project checks and produces a production bundle in `dist/`.

## AI summarization (optional)

The editor's AI Summary panel needs a Groq API key and the standalone summary service. Everything
else in TSG runs without either.

1. Create a key at <https://console.groq.com>.
2. Copy `.env.example` to `.env` and set `GROQ_API_KEY`. `.env` is gitignored; never commit a key.
3. Run the service: `npm run llm` (port 4455 by default, set `SUMMARY_PORT` to change it).

`npm run dev:all` starts the web app, the signaling service and the summary service together;
`npm run dev` still runs the web app alone, as before. Either way the Vite dev server mounts the
same summary handler on `/api/summarize`, so the browser works same-origin with no extra
configuration and no second process.

| Variable | Process | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | summary service | Provider key. Required; without it the route answers 503 and the panel says summaries are not configured. |
| `GROQ_MODEL` | summary service | Model override. Defaults to `openai/gpt-oss-20b`. |
| `SUMMARY_PORT` | summary service | Listening port. Defaults to 4455. |
| `SUMMARY_ALLOWED_ORIGINS` | summary service | Comma-separated browser origins permitted cross-origin. Same-origin needs no entry. |
| `VITE_SUMMARY_URL` | frontend | Where the browser posts summary requests. Defaults to the same-origin `/api/summarize`. |

Check the service with `curl http://localhost:4455/health`, which reports whether a key is loaded
without revealing it.

Privacy: clicking AI Summary sends that document's text to Groq, a third party, for processing.
Nothing is sent until the click, the service stores no document content and logs only a character
count, and the resulting summary stays in the requesting browser unless the user inserts it. Do not
enable this for documents that may not leave your infrastructure.

## Current limitations

The landing page and dashboard are implemented. Document metadata and rich-text content save in separate IndexedDB stores for this origin; browser storage and transaction errors are surfaced. On first open, a one-time migration imports Phase 2 localStorage documents and retains the source data. TipTap Collaboration edits a per-document Y.Doc persisted by y-indexeddb. The editor supports headings, paragraphs, bold, italic, underline, strike, text alignment, lists/checklists, safe links, tables, blockquotes, code blocks, Yjs-backed undo/redo, and word/character counts.

AI summarization is optional and cloud-based: it requires internet access and a Groq key, is
disabled while the browser is offline, and has no local-inference path. It is a separate service
from signaling and is not required for any other feature.

There is no peer networking/signaling, profile identity, service worker, or installable/offline app shell yet. Local Yjs CRDT convergence is tested in independent in-memory replicas; this does not establish network collaboration. The app cannot promise offline application reopening.
