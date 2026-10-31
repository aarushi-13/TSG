export function getSignalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL?.trim()
  if (configured) return configured
  if (typeof window === 'undefined') throw new Error('Configure VITE_SIGNALING_URL outside a browser.')
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.hostname}:4444`
}

/** STUN URLs are public connection discovery configuration, not credentials. */
export function getIceServers(): RTCIceServer[] {
  const configured = import.meta.env.VITE_STUN_URLS?.split(',').map(url => url.trim()).filter(Boolean)
  const urls = configured?.length ? configured : ['stun:stun.l.google.com:19302']
  return urls.map(url => ({ urls: url }))
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
