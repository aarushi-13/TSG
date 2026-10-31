import { createServer } from 'node:http'
import { handleSummarize } from './summarize.js'

/**
 * Standalone AI summarization service.
 *
 * Deliberately its own process, separate from the WebRTC signaling service: summaries need an
 * outbound internet connection and a provider API key, while signaling is a key-less rendezvous
 * that peers depend on for collaboration. Keeping them apart means an LLM outage, a bad key or a
 * provider rate limit cannot take document sync down with it, and the signaling service never
 * needs the API key in its environment.
 */

const DEFAULT_PORT = 4455

function parseAllowedOrigins(value) {
  return (value ?? '').split(',').map(origin => origin.trim()).filter(Boolean)
}

/** Echoes back only origins that were explicitly allowed; no list means same-origin use only. */
function applyCors(request, response, allowedOrigins) {
  const origin = request.headers.origin
  if (!origin) return true
  if (!allowedOrigins.includes(origin)) return false
  response.setHeader('access-control-allow-origin', origin)
  response.setHeader('vary', 'origin')
  response.setHeader('access-control-allow-headers', 'content-type')
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  response.setHeader('access-control-max-age', '600')
  return true
}

export function createSummaryService(allowedOrigins = parseAllowedOrigins(process.env.SUMMARY_ALLOWED_ORIGINS)) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname

    if (!applyCors(request, response, allowedOrigins)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Origin not allowed.')
      return
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method === 'GET' && path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', configured: Boolean(process.env.GROQ_API_KEY) }))
      return
    }

    if (path === '/api/summarize') {
      void handleSummarize(request, response).catch(() => {
        if (!response.writableEnded) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('Summary failed. Please try again.')
        }
      })
      return
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })

  return {
    server,
    listen: port => new Promise(resolve => server.listen(port, () => resolve(server.address()))),
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, '/')}`).href

if (invokedDirectly) {
  const port = Number(process.env.SUMMARY_PORT) || DEFAULT_PORT
  const service = createSummaryService()
  await service.listen(port)
  const configured = process.env.GROQ_API_KEY ? 'with a provider key' : 'WITHOUT a provider key (requests will return 503)'
  console.log(`[summary] AI summarization service listening on http://localhost:${port} ${configured}`)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { void service.close().then(() => process.exit(0)) })
  }
}
