export function getSignalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL?.trim()
  if (configured) return configured
  if (typeof window === 'undefined') throw new Error('Configure VITE_SIGNALING_URL outside a browser.')
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}`
}

/** ICE server configuration is public connection discovery data, not credentials. */
export function getIceServers(): RTCIceServer[] {
  const configured = import.meta.env.VITE_ICE_SERVERS?.trim()
  if (configured) {
    let parsed: unknown
    try { parsed = JSON.parse(configured) }
    catch { throw new Error('VITE_ICE_SERVERS must be a JSON array of ICE server objects.') }
    if (!Array.isArray(parsed) || parsed.some(server => !server || typeof server !== 'object' || Array.isArray(server) || !('urls' in server) || !(typeof server.urls === 'string' || (Array.isArray(server.urls) && server.urls.every((url: unknown) => typeof url === 'string'))))) {
      throw new Error('VITE_ICE_SERVERS must be a JSON array of ICE server objects with a urls field.')
    }
    return parsed as RTCIceServer[]
  }
  const legacyStunUrls = import.meta.env.VITE_STUN_URLS?.split(',').map(url => url.trim()).filter(Boolean)
  if (legacyStunUrls?.length) return legacyStunUrls.map(url => ({ urls: url }))
  return [{ urls: 'stun:stun.l.google.com:19302' }]
}

export type LocalCollaborator = { id: string; name: string; color: string }

const colors = ['#597a62', '#9a6d61', '#667d9b', '#8a7550', '#806b98', '#527f7d']

function createIdentityId(): string {
  const browserCrypto = globalThis.crypto
  if (typeof browserCrypto.randomUUID === 'function') return browserCrypto.randomUUID()
  return Array.from(browserCrypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
}

export function getLocalCollaborator(): LocalCollaborator {
  const key = 'tsg.peer-identity.v1'
  let id = ''
  try {
    id = window.localStorage.getItem(key) ?? ''
    if (!id) {
      id = createIdentityId()
      window.localStorage.setItem(key, id)
    }
  } catch {
    id = createIdentityId()
  }
  const index = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length
  return { id, name: `Guest ${id.slice(0, 4)}`, color: colors[index] }
}
