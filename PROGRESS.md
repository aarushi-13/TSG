# Development progress

## Phase 1 — Foundation (implemented)

- [x] React, TypeScript, Vite, Tailwind, React Router, Zustand, and Lucide setup.
- [x] Responsive TSG landing page and dashboard shell.
- [x] Landing page route retained and covered by a component test.
- [x] Initial design system and application navigation.
- [x] Production build passes.

## Phase 2 — Editor (implemented and verified)

- [x] TipTap 3.32.2 integrated with ProseMirror.
- [x] Rich text: paragraphs, headings (levels 1–3), bold, italic, underline, strikethrough, text alignment, bullet/ordered/task lists, links, tables, blockquotes, and code blocks.
- [x] Toolbar undo/redo, accessible formatting controls, title editing, and placeholder text.
- [x] Word and character counts.
- [x] Document create, open, rename, duplicate, and confirmed delete flows.
- [x] Search, title/recent sorting, and grid/list views now use actual local documents.
- [x] Debounced title and TipTap JSON autosave through the document repository; Phase 3 moved persistence to IndexedDB.
- [x] Storage failures and malformed legacy data are surfaced without claiming success or overwriting unreadable data.
- [x] Formatting, autosave, CRUD, error handling, and landing route covered by Vitest/component tests (expanded during Phase 3).
- [x] Strict TypeScript production build passes; editor code is a lazy-loaded chunk.
- [x] `npm audit` reports zero vulnerabilities after moving to Vitest 4.1.12.

### Phase 2 boundaries

The repository originally used localStorage as a temporary Phase 2 bridge; Phase 3 migrated this data into IndexedDB and leaves the legacy key intact. At Phase 2 close there was no TipTap/Y.Doc binding, peer synchronization, service worker, or offline shell caching. Tests use jsdom and fake IndexedDB; no real-browser or multi-device test has been run.

## Phase 3 — Offline storage (implemented and verified)

- [x] Replaced the synchronous localStorage repository with an asynchronous IndexedDB repository using `idb`.
- [x] Split document metadata and TipTap JSON content into independent object stores.
- [x] Added database initialization/version handling, one connection per repository instance, blocked-upgrade feedback, connection recovery, and surfaced transaction/storage errors.
- [x] Added an idempotent migration for `tsg.documents.v1`: IDs, titles, content, and timestamps are preserved; newer IndexedDB versions are not overwritten.
- [x] Migration commits atomically, verifies migrated records, and writes its completion marker only after verification. The legacy localStorage key is intentionally retained.
- [x] Added a modular y-indexeddb store with one Y.Doc/provider session per document ID, readiness, flush, teardown, and safe update-store deletion APIs.
- [x] Added tests for CRUD/reopen, migration, already-present newer data, concurrent/repeated attempts, malformed/access-failing legacy storage, transaction/quota failure and recovery, and y-indexeddb update persistence.
- [x] Preserved Phase 1 landing and Phase 2 editor/dashboard flows with async persistence.

### Phase 3 verification and boundaries

At the Phase 3 milestone, Vitest exercised persistence using fake IndexedDB and the UI in jsdom. It verified closing/reopening a repository against the same fake IndexedDB database; it did not constitute a Playwright test across real browser restarts. The editor was not yet connected to Y.Doc at that milestone.

## Phase 4 — CRDT integration (implemented and verified)

- [x] Added the official TipTap Collaboration extension and `@tiptap/y-tiptap`, pinned to TipTap 3.32.2 compatible packages.
- [x] Each document editor acquires a unique Y.Doc session from the existing y-indexeddb store; sessions restore before TipTap mounts and release on teardown.
- [x] TipTap content is backed by the document's `default` Y.XmlFragment. StarterKit undo/redo is disabled in collaborative mode and TipTap's Yjs undo/redo commands power the toolbar.
- [x] Existing migrated TipTap JSON seeds a Y.Doc once. An initialization marker and non-empty-fragment check prevent repeated imports from appending/overwriting shared state.
- [x] Y.Doc updates are persisted through y-indexeddb. A debounced TipTap JSON projection keeps dashboard previews/repository compatibility; opening the editor reconciles a stale projection from Yjs.
- [x] Added a separate append-only IndexedDB Yjs update archive with checkpoints and original update bytes, because y-indexeddb can compact its restore log. This preserves operation data for later conflict analysis.
- [x] Added independent Y.Doc/TipTap integration tests for initial state, update generation/application, concurrent edits in separate sections and at one insertion point, reverse update ordering, duplicate updates, convergence comparison, append-only history replay, initialization retry, separate document IDs, and IndexedDB restore.
- [x] Existing Phase 1–3 behavior remains covered by the full test suite.

### Phase 4 verification and boundaries

`npm test` passes 29 tests across four files and `npm run build` passes TypeScript and Vite production checks. The final build keeps the main entry at about 265 kB minified and splits the 93 kB Yjs store from it; the editor chunk is about 497 kB minified. CRDT integration tests use independent Y.Doc instances with real TipTap Collaboration editors and apply Yjs updates directly; they do not use mocked collaboration. This validates CRDT merge behavior, not a network connection. Yjs does not identify semantic overlapping-text conflicts, so preserving competing versions for manual conflict resolution remains future work. No WebRTC, y-webrtc, signaling, awareness/cursors, PWA caching, or independent-browser network testing has been implemented.

## Phase 5 — P2P networking (implemented and verified)

- [x] Added `y-webrtc` and `@tiptap/extension-collaboration-caret`; each open document acquires exactly one provider for its existing Y.Doc, keyed by the stable document ID. TipTap Collaboration continues to use the same Y.Doc and its local y-indexeddb persistence.
- [x] Added a TypeScript WebSocket signaling service that supports y-webrtc room discovery and relays only validated WebRTC announce/offer/answer/ICE-candidate metadata. It sanitizes message shapes, preserves y-webrtc glare tokens, rejects Yjs/document update frames, stores no document content, and exposes health counts only.
- [x] Added configurable signaling URL/STUN URL settings, defaulting to same-host port 4444 and a public STUN URL. No secrets are included in frontend configuration; no TURN credentials are configured.
- [x] Added persisted local peer identity and Yjs Awareness metadata, live remote collaborator avatars, actual WebRTC connection state, signaling state, collaboration cursors/selections, reconnection handling, and provider teardown on editor close/document deletion.
- [x] Added explicit join flow for a shared document ID and a share-link copy action. The document ID is a bearer invite; identity and authorization are not verified by signaling.
- [x] Added signaling service tests for negotiation relay, payload sanitization/no content retention, rejected document-update messages, and metrics.
- [x] Added Playwright tests with independent Chromium browser contexts. They verify actual two-peer WebRTC data channel text exchange and convergence, Awareness avatars/caret, leave/rejoin from persisted local state, signaling interruption/recovery, three-peer Awareness, concurrent updates reaching all three replicas, and distinct room isolation.
- [x] Updated landing copy and README to describe current P2P behavior without claiming PWA/offline-shell support or universal network reachability.

### Phase 5 verification and boundaries

`npm test` passes 31 tests across five files. `npm run test:e2e` passes 2 Playwright tests in separate Chromium contexts against the real Vite app and an in-process signaling service. The browser tests confirm bidirectional Yjs edits, multi-peer concurrent-edit convergence, Awareness presence/caret, room isolation, peer departure/rejoin, and signaling reconnect. The signaling server and integration test files pass their strict TypeScript check; the frontend TypeScript/Vite production build passes. The production build still emits a chunk-size warning for the approximately 504 kB editor chunk. `npm audit` reported zero vulnerabilities after upgrading `ws` to the patched 8.x line. Local tests do not establish actual two-laptop Wi-Fi, cross-network/NAT reachability, STUN-only behavior across public networks, or TURN relay behavior. Full signaling authentication, verified identities, end-to-end identity security, semantic overlapping-text conflict detection/manual resolution, PWA caching, and long-duration offline recovery are not implemented.

The test service's interruption hook is available only to in-process callers; there is no network control endpoint. The app reports direct peer connection independently from signaling availability, since an established WebRTC channel can remain live while signaling is temporarily unavailable.

## Document version history enhancement

- [x] Added an independent `DocumentVersionHistory` manager backed by a version map inside the existing per-document Y.Doc. It stores full TipTap JSON snapshots and does not alter conflict detection, conflict review, provider lifecycle, or IndexedDB autosave.
- [x] Automatic checkpointing observes local TipTap transactions only, adds a shared starting baseline before the first local edit, and waits for a 30-second quiet window by default. It requires at least 80 changed text characters, two changed blocks, or a formatting/structure change, and enforces a five-minute minimum between automatic checkpoints. These values are configurable through `VersionCheckpointPolicy`.
- [x] Added named manual checkpoints, useful author/timestamp information, exact and near-duplicate suppression, a dedicated history panel with current synchronization state, and validated full-format restore through the mounted editor and existing Y.Doc.
- [x] Restore adds a new history record while preserving older entries and the existing Y.Doc, y-indexeddb persistence, WebRTC provider, and Awareness. Offline peers receive the update through normal Yjs synchronization when they reconnect.
- [x] Added unit tests for short pauses, grouped edits, meaningful changes, manual names, duplicate snapshots, rich formatting, replica synchronization, and existing conflict-manager regression coverage.
- [x] Added an independent-browser scenario that creates named versions, takes one peer offline, restores a formatted version on the connected peer, reconnects, and compares restored content, version history, and peer synchronization state.

### Verification and limits

`npm test` passes 44 tests across eight files. `npm run test:e2e` passes all six Playwright scenarios in independent Chromium contexts, including the new offline-peer restore and reconnect flow. That scenario confirms rich text remains formatted, the restored content and restore entry arrive at the offline peer, and the existing sync indicator reaches “Synced with connected peers.” Existing browser conflict-resolution, Yjs collaboration, Awareness, restart recovery, and three-peer reconnection scenarios also pass. `npm run build`, `npm run typecheck:integration`, and `npm run signaling:build` pass. The frontend build retains the existing Vite advisory for the approximately 528 kB editor chunk.

This enhancement does not implement the PWA/service worker, offline app-shell reopening, or cross-network/TURN guarantees. Automatic checkpoints are intentionally conservative; tiny edits remain part of the current version until they accumulate into a substantial change, or the user creates a named version. The signaling service and all conflict detection/resolution source files were left unchanged.

## Saved version deletion

- [x] Added a per-version trash action with confirmation; the live document snapshot is protected from deletion.
- [x] Deleting removes only that version's key from the shared Yjs version map, leaves the editor/Y.Doc and all other versions unchanged, and flushes through the existing y-indexeddb session before reporting success.
- [x] Successful deletion updates the panel immediately and synchronizes its Yjs deletion to connected peers and peers that reconnect later. Cancellation leaves the version intact; storage flush failures are shown as errors instead of success.
- [x] Added unit coverage for active-version protection, selective deletion, unchanged current content, peer update propagation, and y-indexeddb recovery after a session restart. Added Playwright coverage for confirmation cancellation, multi-peer deletion, browser-profile restart persistence, and unchanged live content.

### Verification and storage boundary

`npm test` passes 46 tests across eight files. `npm run test:e2e` passes all seven Playwright scenarios, including the new confirmation/cancellation, peer synchronization, persistent-profile restart and current-content checks. `npm run build`, `npm run typecheck:integration`, and `npm run signaling:build` pass. The frontend build retains Vite's advisory for the approximately 529 kB editor chunk.

Deletion removes the snapshot from the active shared version map and persists that Yjs deletion. Yjs and the separate raw-update archive retain CRDT tombstones/earlier update bytes so peers can merge safely; this is not secure physical erasure of historical update data. No document update history, peer provider, or document content is deleted.

## Phase 6 — Offline synchronization (implemented and verified within documented test scope)

- [x] Browser offline events explicitly disconnect the y-webrtc provider. Local edits continue in the existing Y.Doc and y-indexeddb persistence layer; no second document state or central document sync service was added.
- [x] Reconnection restores the y-webrtc Awareness identity and advertises the current Yjs state vector. This handles y-webrtc clearing the local Awareness state during disconnect.
- [x] Synchronization status distinguishes local-only, synchronizing, synced, and persistence error states. `Synced` requires an active peer, y-webrtc room sync, and matching local/remote Yjs state vectors for connected peers.
- [x] Added shared block-level edit snapshots with author, causal vectors, timestamp, rich ProseMirror JSON and stable Yjs item identity. Sequential character transactions are grouped by block and concurrent editing episode rather than turned into pairwise character conflicts.
- [x] Canonical conflict identity uses document ID, stable block ID, and each participant's first intent in the episode. Duplicate/replayed updates reuse the canonical record; distinct paragraphs remain separate entries. Legacy v1 pairwise records remain stored and are consolidated into v2 records, carrying forward resolved status.
- [x] Concurrent edits in one logical paragraph preserve each participant's complete paragraph snapshot. The review UI resolves one block only, preserving its node type, attrs, marks, links and parent list/table structure. Custom resolution retains the block structure and surrounding inline marks.
- [x] Added Vitest tests for same-paragraph whole-version grouping across many character updates, insertion/deletion groups, different paragraphs, exactly two conflicts for two paragraphs, duplicate/out-of-order replay, unresolved recovery, resolution/replay, legacy migration and stable Yjs block IDs.
- [x] Added independent Chromium tests demonstrating exactly one review record for a multi-character paragraph conflict, two entries for two conflicting paragraphs, rich formatting preservation, unresolved-conflict recovery after gracefully restarting a persistent browser process with the same profile, shared resolution and document convergence.

### Phase 6 verification and boundaries

`npm test` passes 40 tests across seven files. `npm run test:e2e` passes five Playwright scenarios with separate Chromium contexts and real y-webrtc/WebRTC transport. The conflict-specific browser test demonstrates exactly one conflict entry for one edited paragraph, persistence of an unresolved conflict across graceful browser-process restarts using the same persistent profile, rich formatting retained in both surrounding and resolved paragraphs, and converged content after resolution. A second browser test demonstrates exactly two entries for two conflicting paragraphs and verifies resolving one leaves the other block intact. The three-peer recovery test still confirms normalized content and matching state vectors after C/A/B reconnection. `npm run typecheck:integration`, `npm run build`, and `npm run signaling:build` pass. The editor bundle is 519.64 kB minified and remains above Vite's 500 kB advisory threshold.

The browser tests simulate short offline intervals (seconds), not weeks or months. The process-restart scenario restores with the browser online; service-worker/app-shell caching is Phase 7, so reopening the application itself while offline is not guaranteed. Abrupt browser crashes and long-duration storage eviction/quota tests were not run in Phase 6. Existing persistence unit tests cover transaction failures and recovery using fake IndexedDB, not physical storage pressure. Conflict grouping is per stable text block and causal episode, while classification remains based on text-block snapshots rather than general semantic interpretation of every rich-text operation. Actual LAN, restrictive NAT, TURN and multi-device long-duration scenarios remain untested. The suite asserts convergence and successful recovery but does not yet collect latency, synchronized-update, or long-run recovery-rate metrics.

## Next milestone — Phase 7: PWA

Add the manifest, versioned service worker and application-shell/static-asset caching, then verify offline reopening after an initial online visit in real browser contexts. Keep this separate from document synchronization: peers remain the only document sync path, and the PWA cache must not be described as offline document backup.
