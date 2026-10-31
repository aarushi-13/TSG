# Deployment

## Planned services

- Static frontend: Vercel or Netlify.
- Signaling: a small separately deployed service with no document persistence.
- TURN: optional connectivity relay for peers unable to establish direct paths.

Set signaling and ICE server configuration through environment variables. Do not log document content. Document the signaling service's transient role and define room abuse controls before exposing it publicly.

## Status

No production deployment configuration exists in Phase 1.
