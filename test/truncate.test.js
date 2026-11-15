import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, TRUNCATE_ROUTE } from '../index.js'

/**
 * Build a session log with contiguous sequence numbers.
 * @param {Array<[string, unknown]>} entries - Event type and payload pairs.
 * @returns {object[]} Raw events.
 */
function log(entries) {
  return entries.map((entry, index) => ({ type: entry[0], seq: index, time: Date.now(), data: entry[1] }))
}

/** A complete turn opened by a user message, as V4 stores it. */
function turn(number, id, text) {
  return [
    ['turn/start', { turn: number }],
    ['user/message', { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    ['assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }],
    ['turn/end', { turn: number }],
  ]
}

/**
 * Wire a Host context whose route handlers can be driven directly.
 * @param {object[]} events - Session log served by `readSession`.
 * @returns {{ routes: Map<string, Function>, appends: object[], read: () => object[] }} Harness.
 */
function harness(events) {
  const routes = new Map()
  const appends = []
  const live = {
    surface: { nodes: [] },
    append(type, data, intent) {
      appends.push({ type, data, intent })
      live.surface.nodes.push(90 + appends.length)
      return { seq: 90 + appends.length, type, data }
    },
  }
  const ctx = {
    effect: register => register(),
    logger: { warn() {} },
    connection: { fetch: { register: definition => { routes.set(definition.path, definition.fetch); return () => {} } } },
    sessionQuery: { readSession: async () => ({ events }) },
    sessions: { get: () => live, flush: async () => true },
  }
  apply(ctx)
  return { routes, appends, read: () => events, live }
}

/**
 * Drive the truncate route.
 * @param {Function} handler - Route handler.
 * @param {object} body - Request payload.
 * @returns {Promise<object>} Parsed JSON response.
 */
async function call(handler, body) {
  const request = new Request('http://127.0.0.1/api/dk-dsh-context-tree/truncate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dk-context-tree': '1' },
    body: JSON.stringify(body),
  })
  const response = await handler(request)
  return { status: response.status, body: await response.json() }
}

test('truncate appends one replacement over the chosen suffix', async () => {
  const events = log([...turn(1, 'a', 'first question'), ...turn(2, 'b', 'second question')])
  const { routes, appends, live } = harness(events)
  live.surface.nodes = events.map(event => event.seq)

  const result = await call(routes.get(TRUNCATE_ROUTE), { sessionId: 's', messageId: 'b' })

  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(appends.length, 1)
  assert.equal(appends[0].type, 'user/message')
  assert.deepEqual(appends[0].intent.surfaceOp, { op: 'replace', startSeq: 5, endSeq: 7 })
  assert.equal(appends[0].data.source.kind, 'context-tree-rewind')
  assert.equal(result.body.text, 'second question')
})

test('a second rewind shadows the marker the first one left behind', async () => {
  // turn1, turn2, the marker the first rewind appended, then turn3.
  const events = log([...turn(1, 'a', 'q1'), ...turn(2, 'b', 'q2')])
  const marker = {
    type: 'user/message',
    seq: events.length,
    time: Date.now(),
    data: { id: 'rewind-x', role: 'user', content: [{ type: 'text', text: 'q2' }], source: { kind: 'context-tree-rewind' } },
    surfaceOp: { op: 'replace', startSeq: 5, endSeq: 7 },
  }
  events.push(marker)
  for (const entry of turn(3, 'c', 'q3')) events.push({ type: entry[0], seq: events.length, time: Date.now(), data: entry[1] })

  const { routes, appends, live } = harness(events)
  live.surface.nodes = events.map(event => event.seq)

  const result = await call(routes.get(TRUNCATE_ROUTE), { sessionId: 's', messageId: 'c' })

  assert.equal(result.body.ok, true)
  assert.equal(appends.length, 1)
  assert.equal(appends[0].intent.surfaceOp.startSeq, marker.seq, 'the older marker is covered too, so markers never stack')
  assert.equal(appends[0].intent.surfaceOp.endSeq, events.at(-1).seq)
})

test('a running turn refuses the rewind instead of racing it', async () => {
  const events = log([
    ['turn/start', { turn: 1 }],
    ['user/message', { id: 'a', role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }],
  ])
  const { routes, appends } = harness(events)

  const result = await call(routes.get(TRUNCATE_ROUTE), { sessionId: 's', messageId: 'a' })

  assert.equal(result.status, 409)
  assert.equal(result.body.reason, 'session-busy')
  assert.equal(appends.length, 0)
})

test('a message outside the live surface is refused', async () => {
  const events = log([...turn(1, 'a', 'q1'), ...turn(2, 'b', 'q2')])
  const { routes, live } = harness(events)
  live.surface.nodes = [5, 6, 7] // the first turn's message at seq 1 is no longer in the surface

  const result = await call(routes.get(TRUNCATE_ROUTE), { sessionId: 's', messageId: 'a' })

  assert.equal(result.status, 409)
  assert.equal(result.body.reason, 'not-surface-node')
})

test('a cross-origin or unmarked request never reaches a handler', async () => {
  const events = log([...turn(1, 'a', 'q1')])
  const { routes } = harness(events)
  const handler = routes.get(TRUNCATE_ROUTE)

  const unmarked = await handler(new Request('http://127.0.0.1/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', messageId: 'a' }),
  }))
  assert.equal(unmarked.status, 403)

  const foreign = await handler(new Request('http://127.0.0.1/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dk-context-tree': '1', origin: 'https://evil.example' },
    body: JSON.stringify({ sessionId: 's', messageId: 'a' }),
  }))
  assert.equal(foreign.status, 403)
})
