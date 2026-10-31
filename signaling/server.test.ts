import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createSignalingService } from './server'

describe('signaling-only service', () => {
  let service: ReturnType<typeof createSignalingService>
  let address: string

  beforeEach(async () => {
    service = createSignalingService(null)
    await new Promise<void>(resolve => service.server.listen(0, '127.0.0.1', resolve))
    const serverAddress = service.server.address()
    if (!serverAddress || typeof serverAddress === 'string') throw new Error('Signaling service did not bind a TCP port.')
    address = `ws://127.0.0.1:${serverAddress.port}`
  })

  afterEach(async () => { await service.close() })

  it('forwards only negotiation payloads and never stores document contents', async () => {
    const sender = new WebSocket(address)
    const receiver = new WebSocket(address)
    await Promise.all([opened(sender), opened(receiver)])
    const received = nextMessage(receiver)
    sender.send(JSON.stringify({ type: 'subscribe', topics: ['doc:room-a'] }))
    receiver.send(JSON.stringify({ type: 'subscribe', topics: ['doc:room-a'] }))
    await new Promise(resolve => setTimeout(resolve, 20))
    sender.send(JSON.stringify({ type: 'publish', topic: 'doc:room-a', data: { type: 'announce', from: 'peer-a', content: 'private document text' }, content: 'private document text' }))
    const frame = JSON.parse(await received) as { data: { type: string; from: string } }
    expect(frame.data).toEqual({ type: 'announce', from: 'peer-a' })
    expect(service.getMetrics().rooms).toBe(1)

    const response = await fetch(address.replace('ws:', 'http:').replace(/:\d+$/, match => match) + '/health')
    const health = await response.text()
    expect(health).not.toContain('document')
    expect(health).not.toContain('private document text')
    expect(service.getMetrics()).toMatchObject({ connections: 2, rooms: 1, forwarded: 2 })
    sender.close()
    receiver.close()
  })

  it('rejects a document update presented to the signaling channel', async () => {
    const client = new WebSocket(address)
    await opened(client)
    client.send(JSON.stringify({ type: 'subscribe', topics: ['doc:room-b'] }))
    await new Promise(resolve => setTimeout(resolve, 10))
    const closed = nextClose(client)
    client.send(JSON.stringify({ type: 'publish', topic: 'doc:room-b', data: { type: 'update', content: 'private document text' } }))
    const [code] = await closed
    expect(code).toBe(1008)
    expect(service.getMetrics().forwarded).toBe(0)
  })
})

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
}
function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise(resolve => socket.once('message', data => resolve(data.toString())))
}
function nextClose(socket: WebSocket): Promise<[number, Buffer]> {
  return new Promise(resolve => socket.once('close', (code, reason) => resolve([code, reason])))
}
