import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { handleSummarize } from '../server/summarize.js'

const MAX_FRAME_BYTES = 64 * 1024
const MAX_TOPICS_PER_CLIENT = 8
const MAX_TOPIC_LENGTH = 128
const MAX_MESSAGES_PER_SECOND = 120
const FRONTEND_DIRECTORY = resolve(process.cwd(), 'dist')
const SERVER_DIRECTORIES = new Set(['server', 'signaling'])
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

type SignalMessage = {
  type?: unknown
  topics?: unknown
  topic?: unknown
  data?: unknown
}

type SignalingService = {
  server: Server
  close: () => Promise<void>
  interrupt: () => void
  resume: () => void
  getMetrics: () => { connections: number; rooms: number; forwarded: number }
}

/** Serves the app and API while acting as a y-webrtc rendezvous; it has no document-content store. */
export function createSignalingService(allowedOrigins = parseAllowedOrigins(process.env.WS_ALLOWED_ORIGINS)): SignalingService {
  const rooms = new Map<string, Set<WebSocket>>()
  const subscriptions = new Map<WebSocket, Set<string>>()
  const rateWindows = new Map<WebSocket, { start: number; count: number }>()
  let forwarded = 0
  let acceptingConnections = true
  const server = createServer((request, response) => {
    let path: string
    try { path = new URL(request.url ?? '/', 'http://localhost').pathname }
    catch { response.writeHead(400); response.end('bad request'); return }
    if (request.method === 'GET' && path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', connections: subscriptions.size, rooms: rooms.size, summarizerConfigured: Boolean(process.env.GROQ_API_KEY) }))
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
    if (path === '/api' || path.startsWith('/api/')) { response.writeHead(404); response.end('not found'); return }
    if (request.method === 'GET' || request.method === 'HEAD') {
      void serveFrontend(request, response, path)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false })

  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path !== '/' || !acceptingConnections || (allowedOrigins && (!origin || !allowedOrigins.has(origin)))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    websocketServer.handleUpgrade(request, socket, head, websocket => websocketServer.emit('connection', websocket, request))
  })

  websocketServer.on('connection', (client, _request: IncomingMessage) => {
    const joinedRooms = new Set<string>()
    subscriptions.set(client, joinedRooms)
    rateWindows.set(client, { start: Date.now(), count: 0 })

    const removeClient = () => {
      for (const roomName of joinedRooms) {
        const members = rooms.get(roomName)
        members?.delete(client)
        if (members?.size === 0) rooms.delete(roomName)
      }
      joinedRooms.clear()
      subscriptions.delete(client)
      rateWindows.delete(client)
    }
    client.on('close', removeClient)
    client.on('error', removeClient)
    client.on('message', (raw, isBinary) => {
      const rate = rateWindows.get(client)
      if (!rate) return
      const now = Date.now()
      if (now - rate.start >= 1000) { rate.start = now; rate.count = 0 }
      if (++rate.count > MAX_MESSAGES_PER_SECOND || isBinary) { client.close(1008, 'signaling limits exceeded'); return }

      let message: SignalMessage
      try {
        const parsed: unknown = JSON.parse(raw.toString())
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid message')
        message = parsed as SignalMessage
      } catch {
        client.close(1007, 'invalid signaling message')
        return
      }

      if (message.type === 'subscribe' || message.type === 'unsubscribe') {
        if (!Array.isArray(message.topics) || message.topics.length > MAX_TOPICS_PER_CLIENT) { client.close(1008, 'invalid topic list'); return }
        for (const value of message.topics) {
          if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOPIC_LENGTH) { client.close(1008, 'invalid topic'); return }
          const members = rooms.get(value)
          if (message.type === 'subscribe') {
            if (joinedRooms.size >= MAX_TOPICS_PER_CLIENT && !joinedRooms.has(value)) { client.close(1008, 'too many rooms'); return }
            const topic = members ?? new Set<WebSocket>()
            topic.add(client)
            rooms.set(value, topic)
            joinedRooms.add(value)
          } else {
            members?.delete(client)
            if (members?.size === 0) rooms.delete(value)
            joinedRooms.delete(value)
          }
        }
        return
      }

      if (message.type === 'ping') {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'pong' }))
        return
      }

      if (message.type === 'publish') {
        const negotiation = sanitizeNegotiationMessage(message.data)
        if (typeof message.topic !== 'string' || !joinedRooms.has(message.topic) || !negotiation) {
          client.close(1008, 'only WebRTC negotiation messages are accepted')
          return
        }
        const members = rooms.get(message.topic)
        if (!members) return
        const frame = JSON.stringify({ type: 'publish', topic: message.topic, data: negotiation, clients: members.size })
        for (const member of members) {
          if (member.readyState === WebSocket.OPEN) { member.send(frame); forwarded += 1 }
        }
        return
      }

      client.close(1008, 'unsupported signaling message')
    })
  })

  return {
    server,
    getMetrics: () => ({ connections: subscriptions.size, rooms: rooms.size, forwarded }),
    // Test/operations hook exposed only to in-process callers; no network control route exists.
    interrupt: () => {
      acceptingConnections = false
      for (const client of websocketServer.clients) client.close(1012, 'signaling interrupted')
    },
    resume: () => { acceptingConnections = true },
    close: async () => {
      for (const client of websocketServer.clients) client.close(1001, 'signaling service shutting down')
      await new Promise<void>(resolve => websocketServer.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      rooms.clear(); subscriptions.clear(); rateWindows.clear()
    },
  }
}

/** Serves Vite's dist output, while keeping compiled server modules out of the public file tree. */
async function serveFrontend(request: IncomingMessage, response: import('node:http').ServerResponse, pathname: string): Promise<void> {
  let decodedPath: string
  try { decodedPath = decodeURIComponent(pathname) }
  catch { response.writeHead(400); response.end('bad request'); return }

  const requestedPath = decodedPath.replace(/^[/\\]+/u, '')
  const firstSegment = requestedPath.split(/[\\/]/u)[0]
  const relativePath = SERVER_DIRECTORIES.has(firstSegment) ? '__reserved_server_path__' : requestedPath || 'index.html'
  const candidate = resolve(FRONTEND_DIRECTORY, relativePath)
  const fromRoot = relative(FRONTEND_DIRECTORY, candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || fromRoot === resolve(FRONTEND_DIRECTORY)) {
    response.writeHead(403); response.end('forbidden'); return
  }

  let filePath = candidate
  let fileInfo
  try { fileInfo = await stat(filePath) } catch { fileInfo = undefined }
  if (!fileInfo?.isFile()) {
    filePath = resolve(FRONTEND_DIRECTORY, 'index.html')
    try { fileInfo = await stat(filePath) } catch { fileInfo = undefined }
  }
  if (!fileInfo?.isFile()) {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Frontend build is missing. Run npm run build first.')
    return
  }

  const isAsset = relative(FRONTEND_DIRECTORY, filePath).split(sep)[0] === 'assets'
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': fileInfo.size,
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  if (request.method === 'HEAD') { response.end(); return }
  createReadStream(filePath).on('error', () => response.destroy()).pipe(response)
}

function sanitizeNegotiationMessage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as { type?: unknown; from?: unknown; to?: unknown; token?: unknown; signal?: unknown }
  if (message.type === 'announce') return typeof message.from === 'string' && message.from.length <= 128 ? { type: 'announce', from: message.from } : null
  if (message.type !== 'signal' || typeof message.from !== 'string' || message.from.length > 128 || typeof message.to !== 'string' || message.to.length > 128) return null
  if (!message.signal || typeof message.signal !== 'object' || Array.isArray(message.signal)) return null
  const signal = message.signal as { type?: unknown }
  if (message.token !== undefined && (typeof message.token !== 'number' || !Number.isFinite(message.token))) return null
  if (signal.type === 'offer' || signal.type === 'answer') {
    const sdp = (message.signal as { sdp?: unknown }).sdp
    return typeof sdp === 'string' && sdp.length <= MAX_FRAME_BYTES / 2 ? { type: 'signal', from: message.from, to: message.to, ...(typeof message.token === 'number' ? { token: message.token } : {}), signal: { type: signal.type, sdp } } : null
  }
  if (signal.type === 'candidate') {
    const candidate = (message.signal as { candidate?: unknown }).candidate
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const ice = candidate as { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown; usernameFragment?: unknown }
    if (typeof ice.candidate !== 'string' || ice.candidate.length > 16_000) return null
    if (ice.sdpMid != null && typeof ice.sdpMid !== 'string') return null
    if (ice.sdpMLineIndex != null && typeof ice.sdpMLineIndex !== 'number') return null
    if (ice.usernameFragment != null && typeof ice.usernameFragment !== 'string') return null
    return { type: 'signal', from: message.from, to: message.to, ...(typeof message.token === 'number' ? { token: message.token } : {}), signal: { type: 'candidate', candidate: {
      candidate: ice.candidate,
      ...(typeof ice.sdpMid === 'string' || ice.sdpMid === null ? { sdpMid: ice.sdpMid } : {}),
      ...(typeof ice.sdpMLineIndex === 'number' || ice.sdpMLineIndex === null ? { sdpMLineIndex: ice.sdpMLineIndex } : {}),
      ...(typeof ice.usernameFragment === 'string' || ice.usernameFragment === null ? { usernameFragment: ice.usernameFragment } : {}),
    } } }
  }
  return null
}

function parseAllowedOrigins(value: string | undefined): Set<string> | null {
  if (!value?.trim()) return null
  return new Set(value.split(',').map(origin => origin.trim()).filter(Boolean))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = process.env.PORT?.trim() ? Number(process.env.PORT) : 4444
  const service = createSignalingService()
  service.server.listen(port, '0.0.0.0', () => process.stdout.write(`TSG web service listening on 0.0.0.0:${port}\n`))
  const shutdown = () => { void service.close().finally(() => process.exit(0)) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
