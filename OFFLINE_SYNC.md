# Offline synchronization

## Local state and transport

Each document has one Y.Doc. TipTap edits its shared XML fragment, y-indexeddb persists Yjs updates, and the separate IndexedDB repository stores metadata and a JSON preview. Edit intents and conflict records are also shared Yjs data, so they use the same persistence and peer transport. While disconnected, edits continue against the local Y.Doc; no server stores document contents or synchronizes document updates.

When the browser goes offline, the provider disconnects and the editor remains usable with locally saved changes. On reconnect, the provider reconnects, restores local Awareness identity (y-webrtc clears it when disconnecting), advertises the current Yjs state vector and exchanges missing updates directly with peers. Reordered/duplicate Yjs updates are idempotent. The app reports `Synced` only after y-webrtc room sync and exact state-vector matches with all currently connected WebRTC peers. If there is no connected peer, edits are local-only rather than represented as synced.

## Conflict review

Each changed text block is recorded with its author, causal vectors, rich ProseMirror snapshots and Yjs-backed block identity in a shared Y.Array. Intents from multiple character transactions are grouped into concurrent editing episodes by block and causal relationship. Ten operations in one paragraph result in one conflict record; genuinely conflicting paragraphs have separate entries. A canonical ID uses the document, stable block identity and each participant's first edit in the episode. Replayed updates reuse the same entry. Existing v1 pairwise conflict rows are left intact in the Y.Doc and consolidated into canonical records during migration.

The candidate snapshots preserve block type, attrs, marks, links and nested inline content. A choice replaces only the affected block; surrounding text, formatting, headings and list/table parents remain unchanged. Custom text uses the preserved block structure and carries formatting marks through unchanged text and the replacement range. Grouping uses block identity and causality, but it does not infer intent or provide a general semantic merge for arbitrary rich-text operations.

## Verified behavior and limits

The automated Playwright suite uses independent Chromium contexts and actual local WebRTC peers. It verifies short offline periods, a single review record for many concurrent edits in one paragraph, two separate records for two conflicting paragraphs, rich-format preservation, unresolved conflict recovery after gracefully closing and relaunching a persistent Chromium process with the same profile, shared resolution, reconnect order C/A/B across three peers, and matching normalized content. The process-restart test relaunches with network access; it does not establish offline app-shell loading. Vitest exercises causal grouping, duplicate update replay, legacy record consolidation, resolution persistence/replay, stable block identity and local update recovery. Persistence/storage transaction failure tests use fake IndexedDB.

These tests do not simulate weeks of disconnection, an abrupt browser crash, physical quota exhaustion, IndexedDB eviction, or offline loading of the app shell. Those require longer-running and real-browser/platform tests. The app does not yet include a service worker or PWA manifest. A previously loaded app may still fail to reopen after a browser restart without network access; Phase 7 will add application-resource caching, not document-content synchronization.

Browser storage can be evicted or reach quota limits. Persistence errors surface in the UI; do not clear local data as a recovery strategy. See [P2P_NETWORKING.md](./P2P_NETWORKING.md) for STUN/TURN and connectivity limitations.
