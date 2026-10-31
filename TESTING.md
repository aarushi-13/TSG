# Testing

## Planned verification

- Unit tests: local identity, metadata, document creation, persistence, update idempotence.
- Integration: two/three independent Yjs replicas, concurrent edits, offline edits, reordered/duplicate updates, reconnection and convergence.
- Browser: Playwright in separate contexts, including reload/offline/recovery and peer synchronization.
- Fault injection: signaling interruption, network loss, high latency, peer crash, simultaneous reconnect.

Correctness checks must compare normalized serialized document state across all replicas after convergence, not just verify that sockets connected. Measure convergence latency, synchronized updates, recovery success, and data loss incidents.

## Current coverage

Run `npm test`. Vitest, React Testing Library, jsdom, and fake-indexeddb exercise the following coverage:

- IndexedDB repository create, separate metadata/content stores, fresh repository reopen, rename/duplicate/delete, and durable rich-text content.
- Legacy migration field preservation, retaining the localStorage source, newer existing data precedence, repeated/concurrent migration, malformed/access-failure retry, transactional failure rollback, and recovery.
- y-indexeddb provider singleton behavior, update flush/reopen, and update-store deletion/reset.
- Real TipTap Collaboration editors attached to independent Y.Docs: legacy JSON seeding, concurrent edits in different paragraphs and at the same text position, update exchange in both orders, duplicate replay, normalized content convergence, append-only update archive replay, initialization retry, multiple documents, and XML content recovery after persistence teardown/reopen.
- TipTap toolbar rendering, heading and bold commands, debounced content autosave, title autosave, word/character counts, and failed-save status.
- Dashboard landing route, async IndexedDB load, new-document flow, editor title save, document list, rename, duplicate, confirmed deletion, quota-error UI, and corrupt-storage UI.

`npm run build` performs the TypeScript check and production Vite build. Phase 4's historical unit checks used actual Y.Doc instances and TipTap Collaboration and tested CRDT convergence after direct update exchange. Persistence unit recovery uses fake IndexedDB. PWA offline reopen and browser-process crash/restart are not implemented.

Phase 5 adds signaling service tests plus Playwright with independent Chromium browser contexts against the real Vite UI, y-webrtc, WebRTC data channels, and a local signaling service:

- `npm run signaling:build` strictly type-checks and compiles the Node signaling process.
- `npx playwright install chromium` installs the browser needed for the integration suite.
- `npm run test:e2e` verifies two-peer bidirectional Yjs exchange and convergence, Awareness avatars/caret rendering, peer disconnect/rejoin, signaling interruption/recovery, three-peer concurrent edits reaching every replica, and room isolation.
- `npm test` includes signaling WebSocket protocol tests that validate/sanitize negotiation messages and reject document update payloads.

Phase 6 extends `npm test` with conflict intent/classification, competing candidate preservation, custom resolution, and CRDT recovery tests. The Playwright suite also covers independent offline edits, tab close/reopen after network restoration, both conflict alternatives, shared resolution, three offline peers reconnecting in C/A/B order, normalized content convergence, and identical Yjs state vectors. These local tests verify real peer transport on loopback and short offline intervals; they do not establish connectivity through arbitrary public NATs, TURN relays, weeks-long offline sessions, browser-process restarts, or real storage eviction/quota exhaustion. For LAN testing between two laptops, see [P2P_NETWORKING.md](./P2P_NETWORKING.md).
