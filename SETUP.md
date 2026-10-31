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

## Current limitations

The landing page and dashboard are implemented. Document metadata and rich-text content save in separate IndexedDB stores for this origin; browser storage and transaction errors are surfaced. On first open, a one-time migration imports Phase 2 localStorage documents and retains the source data. TipTap Collaboration edits a per-document Y.Doc persisted by y-indexeddb. The editor supports headings, paragraphs, bold, italic, underline, strike, text alignment, lists/checklists, safe links, tables, blockquotes, code blocks, Yjs-backed undo/redo, and word/character counts.

There is no peer networking/signaling, profile identity, service worker, or installable/offline app shell yet. Local Yjs CRDT convergence is tested in independent in-memory replicas; this does not establish network collaboration. The app cannot promise offline application reopening.
