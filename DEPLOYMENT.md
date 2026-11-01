# Deployment

## One Node web service

Deploy the Node service as one web service. It serves the built frontend from `dist/`, handles
`/api/summarize`, exposes `/health`, and accepts y-webrtc WebSocket signaling on the same port.
The server binds to `0.0.0.0` and uses the platform's `PORT` value, falling back to `4444`.

Build and start commands:

```sh
npm ci
npm run build
npm start
```

The hosting platform should run `npm run build` during its build/release step and `npm start` as the
web process. TLS may terminate at the platform's proxy; forward both HTTP and WebSocket upgrades to
the same Node port. The frontend chooses `ws:` or `wss:` from the page protocol and uses that same
host and port by default. Set `VITE_SIGNALING_URL` only when signaling is hosted elsewhere.

## Environment

- `PORT`: service port; defaults to `4444`.
- `GROQ_API_KEY`: server-only provider key. Without it, `/api/summarize` returns HTTP 503 with the
  existing not-configured message. Never set this as a `VITE_*` variable.
- `GROQ_MODEL`: optional Groq model override; defaults to `openai/gpt-oss-20b`.
- `WS_ALLOWED_ORIGINS`: optional comma-separated exact browser origins allowed to connect over
  WebSocket. Leave unset for a same-origin deployment.
- `VITE_SIGNALING_URL`: optional public WebSocket URL override, supplied at frontend build time.
- `VITE_ICE_SERVERS`: optional JSON array of public `RTCIceServer` objects, supplied at build time.
  The default is Google's public STUN server.
- `VITE_SUMMARY_URL`: optional public summary URL override, useful for local development. The
  default is the relative `/api/summarize` path.

Copy `.env.example` to `.env` for local configuration. The production host should configure
`GROQ_API_KEY` and `GROQ_MODEL` as server environment variables; only `VITE_*` values are embedded
in the built browser bundle.

## Health and service boundaries

`GET /health` returns status, active signaling connection and room counts, and whether the summary
provider key is configured. It does not return document content. Signaling holds only transient room
membership and validated WebRTC negotiation messages; Yjs document updates are exchanged directly
between peers and are not stored by this service. The summary route runs in the same process but
stores no documents and logs only a character count. Clicking Summarize sends the open document text
to Groq for processing.

Use HTTPS/WSS in production. TURN remains optional for networks that cannot establish direct WebRTC
connections. `VITE_ICE_SERVERS` is embedded in the public frontend bundle, so use only TURN
credentials intended for browser clients; do not put long-lived secrets there. Before exposing
signaling publicly, define room abuse controls and rate limits appropriate to the deployment.
