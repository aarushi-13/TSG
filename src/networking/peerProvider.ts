import { WebrtcProvider } from 'y-webrtc'
import * as Y from 'yjs'
import type { YjsDocumentSession } from '../persistence/yjsStore'
import { getIceServers, getSignalingUrl, type LocalCollaborator } from './config'

export type PeerConnectionStatus = 'offline' | 'signaling-unavailable' | 'waiting' | 'connecting' | 'connected'

export type RemoteCollaborator = LocalCollaborator & { clientId: number }

export type PeerNetworkSnapshot = {
  status: PeerConnectionStatus
  signalingConnected: boolean
  discoveredPeerCount: number
  connectedPeerCount: number
  synchronized: boolean
  syncStatus: 'local-only' | 'synchronizing' | 'synced'
  collaborators: RemoteCollaborator[]
}

type SignalingConnection = {
  connected: boolean
  on: (event: 'connect' | 'disconnect', listener: () => void) => void
  off: (event: 'connect' | 'disconnect', listener: () => void) => void
}

type PeerMap = Map<string, { connected: boolean }>
type ProviderRoom = { webrtcConns: PeerMap; synced: boolean }

function getRoom(provider: WebrtcProvider): ProviderRoom | null {
  return provider.room as ProviderRoom | null
}

function getCollaborators(provider: WebrtcProvider): RemoteCollaborator[] {
  return [...provider.awareness.getStates().entries()]
    .filter(([clientId]) => clientId !== provider.awareness.clientID)
    .flatMap(([clientId, rawState]) => {
      if (!rawState || typeof rawState !== 'object') return []
      const state = rawState as { user?: Partial<LocalCollaborator> }
      const user = state.user
      if (!user || typeof user.id !== 'string' || typeof user.name !== 'string' || typeof user.color !== 'string') return []
      return [{ clientId, id: user.id, name: user.name, color: user.color }]
    })
}

function sameVector(left: Map<number, number>, right: Map<number, number>): boolean {
  if (left.size !== right.size) return false
  for (const [client, clock] of right) if (left.get(client) !== clock) return false
  return true
}

export class PeerNetworkSession {
  readonly provider: WebrtcProvider
  private snapshot: PeerNetworkSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly signalingConnections: SignalingConnection[]
  private readonly signalingListener = () => this.refresh()
  private readonly providerListener = () => this.refresh()
  private readonly providerSyncListener = () => { this.publishSyncVector(); this.refresh() }
  private readonly awarenessListener = () => this.refresh()
  private readonly onlineListener = () => {
    this.provider.connect()
    // y-webrtc removes the local Awareness state on disconnect. Restore identity and
    // the current vector explicitly or peers retain only the pre-disconnect vector.
    this.provider.awareness.setLocalState({
      user: this.collaborator,
      syncVector: [...Y.encodeStateVector(this.provider.doc)],
    })
    this.refresh()
  }
  private readonly offlineListener = () => { this.provider.disconnect(); this.refresh() }
  private readonly documentUpdateListener = () => this.publishSyncVector()
  private readonly pollingTimer: ReturnType<typeof setInterval>
  private closed = false

  constructor(readonly documentId: string, document: YjsDocumentSession['doc'], private readonly collaborator: LocalCollaborator) {
    this.provider = new WebrtcProvider(documentId, document, {
      signaling: [getSignalingUrl()],
      maxConns: 32,
      filterBcConns: true,
      peerOpts: { config: { iceServers: getIceServers() } },
    })
    this.provider.awareness.setLocalStateField('user', collaborator)
    this.publishSyncVector()
    this.signalingConnections = this.provider.signalingConns as SignalingConnection[]
    for (const connection of this.signalingConnections) {
      connection.on('connect', this.signalingListener)
      connection.on('disconnect', this.signalingListener)
    }
    this.provider.on('status', this.providerListener)
    this.provider.on('synced', this.providerSyncListener)
    this.provider.on('peers', this.providerSyncListener)
    this.provider.awareness.on('change', this.awarenessListener)
    document.on('update', this.documentUpdateListener)
    window.addEventListener('online', this.onlineListener)
    window.addEventListener('offline', this.offlineListener)
    this.snapshot = this.buildSnapshot()
    // y-webrtc reports peer discovery before its data channel opens. Poll the actual peer state too.
    this.pollingTimer = setInterval(this.providerListener, 500)
  }

  getSnapshot = (): PeerNetworkSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private buildSnapshot(): PeerNetworkSnapshot {
    const room = getRoom(this.provider)
    const peers = room ? [...room.webrtcConns.values()] : []
    const connectedPeerCount = peers.filter(peer => peer.connected).length
    const signalingConnected = this.signalingConnections.some(connection => connection.connected)
    const online = typeof navigator === 'undefined' || navigator.onLine
    const status: PeerConnectionStatus = connectedPeerCount > 0
      ? 'connected'
      : !online
        ? 'offline'
        : !signalingConnected
          ? 'signaling-unavailable'
          : peers.length > 0
            ? 'connecting'
            : 'waiting'
    const localVector = Y.decodeStateVector(Y.encodeStateVector(this.provider.doc))
    const remoteVectors = [...this.provider.awareness.getStates().entries()]
      .filter(([clientId]) => clientId !== this.provider.awareness.clientID)
      .map(([, state]) => state && typeof state === 'object' ? (state as { syncVector?: unknown }).syncVector : undefined)
      .filter((value): value is number[] => Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255))
      .map(value => Y.decodeStateVector(Uint8Array.from(value)))
    const stateVectorsMatch = remoteVectors.every(vector => sameVector(vector, localVector))
    const roomSynced = Boolean(room?.synced)
    const synchronized = connectedPeerCount > 0 && roomSynced && remoteVectors.length >= connectedPeerCount && stateVectorsMatch
    return {
      status,
      signalingConnected,
      discoveredPeerCount: peers.length,
      connectedPeerCount,
      synchronized,
      syncStatus: connectedPeerCount === 0 ? 'local-only' : synchronized ? 'synced' : 'synchronizing',
      collaborators: getCollaborators(this.provider),
    }
  }

  private publishSyncVector(): void {
    if (this.closed) return
    this.provider.awareness.setLocalStateField('syncVector', [...Y.encodeStateVector(this.provider.doc)])
  }

  private refresh(): void {
    if (this.closed) return
    const next = this.buildSnapshot()
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return
    this.snapshot = next
    this.listeners.forEach(listener => listener())
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.pollingTimer)
    window.removeEventListener('online', this.onlineListener)
    window.removeEventListener('offline', this.offlineListener)
    for (const connection of this.signalingConnections) {
      connection.off('connect', this.signalingListener)
      connection.off('disconnect', this.signalingListener)
    }
    this.provider.off('status', this.providerListener)
    this.provider.off('synced', this.providerSyncListener)
    this.provider.off('peers', this.providerSyncListener)
    this.provider.awareness.off('change', this.awarenessListener)
    this.provider.doc.off('update', this.documentUpdateListener)
    this.listeners.clear()
    this.provider.destroy()
    // The provider closes its room and peer channels on the resolved key promise.
    void Promise.resolve(this.provider.key).then(() => this.provider.awareness.destroy())
  }
}

type ProviderEntry = { network: PeerNetworkSession; references: number }

/** Keeps exactly one y-webrtc provider per local Y.Doc within an app runtime. */
export class PeerProviderStore {
  private readonly sessions = new Map<string, ProviderEntry>()

  acquire(session: YjsDocumentSession, collaborator: LocalCollaborator): { network: PeerNetworkSession; release: () => void } {
    let entry = this.sessions.get(session.documentId)
    if (entry && entry.network.provider.doc !== session.doc) throw new Error('A document room is already bound to a different Y.Doc in this runtime.')
    if (!entry) {
      entry = { network: new PeerNetworkSession(session.documentId, session.doc, collaborator), references: 0 }
      this.sessions.set(session.documentId, entry)
    }
    entry.references += 1
    let released = false
    return {
      network: entry.network,
      release: () => {
        if (released) return
        released = true
        setTimeout(() => {
          const current = this.sessions.get(session.documentId)
          if (!current) return
          current.references = Math.max(0, current.references - 1)
          if (current.references === 0) {
            current.network.close()
            this.sessions.delete(session.documentId)
          }
        }, 0)
      },
    }
  }

  closeDocument(documentId: string): void {
    const entry = this.sessions.get(documentId)
    if (!entry) return
    entry.network.close()
    this.sessions.delete(documentId)
  }
}

export const peerProviderStore = new PeerProviderStore()
