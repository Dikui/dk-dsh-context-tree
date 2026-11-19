import test from 'node:test'
import assert from 'node:assert/strict'
import { TRUNCATE_ROUTE } from '../index.js'
import { harness } from './route-harness.js'

test('one confirmation replaces only the chosen message surface suffix and returns its draft', async () => {
  const h = harness()
  h.turn(1, 'A'); const start = h.turn(2, 'B')
  const nodes = h.session.surface.nodes.slice()
  const p = await h.preview('B')
  assert.equal(p.ok, true); assert.equal(p.markerMode, 'notice-v1'); assert.equal(typeof p.previewToken, 'string')
  const length = h.events.length, r = await h.confirm('B', p.previewToken)
  assert.equal(r.ok, true); assert.equal(r.text, 'B'); assert.equal(h.events.length, length + 1)
  const marker = h.events.at(-1)
  assert.deepEqual(marker.surfaceOp, { op: 'replace', startSeq: start, endSeq: nodes.at(-1) })
  assert.deepEqual(marker.sourceEventSeqs, nodes.slice(nodes.indexOf(start)))
  assert.deepEqual(r.mask.messageIds, ['B', `rewind-${start}`]); assert.deepEqual(r.mask.turns, [2])
  assert.deepEqual(await h.cut(), { ok: true, ...r.mask })
  assert.equal((await h.confirm('B', p.previewToken)).ok, false)
  assert.equal(h.events.length, length + 1)
})

test('after cutting B, sending C and D, cutting D does not hide C', async () => {
  const h = harness(); h.turn(1, 'A'); const b = h.turn(2, 'B')
  await h.confirm('B', (await h.preview('B')).previewToken)
  const c = h.turn(3, 'C'), d = h.turn(4, 'D')
  const r = await h.confirm('D', (await h.preview('D')).previewToken)
  assert.equal(r.ok, true); assert.equal(h.events.at(-1).surfaceOp.startSeq, d)
  assert.ok(h.session.surface.nodes.includes(c)); assert.deepEqual(r.mask.messageIds, ['B', `rewind-${b}`, 'D', `rewind-${d}`])
})

test('another completed turn invalidates confirmation; missing token or a different target never commits', async () => {
  const h = harness(); h.turn(1, 'A'); h.turn(2, 'B'); const p = await h.preview('B')
  const expectStale = async (id, token) => {
    const before = h.events.length
    assert.equal((await h.confirm(id, token)).reason, 'preview-stale'); assert.equal(h.events.length, before)
  }
  await expectStale('B', undefined); await expectStale('A', p.previewToken)
  h.turn(3, 'C'); await expectStale('B', p.previewToken)
})

test('a token cannot commit without explicit acceptance of the model-visible notice', async () => {
  const h = harness(); h.turn(1, 'A')
  const { previewToken } = await h.preview('A'), before = h.session.seq
  for (const markerMode of [undefined, 'invisible']) {
    const response = await h.routes.get(TRUNCATE_ROUTE)(new Request(`http://localhost${TRUNCATE_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dk-context-tree': '1' },
      body: JSON.stringify({ sessionId: 's', messageId: 'A', previewToken, markerMode, revertFiles: true }),
    }))
    assert.equal((await response.json()).reason, 'preview-unavailable')
    assert.equal(h.session.seq, before); assert.equal(h.mutations.length, 0)
  }
})

test('an open turn, or a message already off-surface, cannot be previewed', async () => {
  const h = harness(); h.turn(1, 'A'); h.turn(2, 'B')
  await h.confirm('B', (await h.preview('B')).previewToken)
  assert.equal((await h.preview('B')).reason, 'not-surface-node')
  h.session.append('turn/start', { turn: 3 }); assert.equal((await h.preview('A')).reason, 'session-busy')
})

test('a stop closing its turn while the preview is read is not a stale preview', async () => {
  // Regression: a stop aborts immediately, but the loop closes the turn later
  // by appending the interrupted assistant message, step/end and turn/end.
  // An asynchronous session read can pick those up after the preview starts.
  // That is the log settling, not a competing revision.
  const h = harness()
  h.session.append('turn/start', { turn: 1 })
  h.session.append('step/start', { turn: 1, step: 1 })
  h.session.append('user/message', {
    id: 'A', role: 'user', content: [{ type: 'text', text: 'A' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  h.session.append('assistant/message', {
    turn: 1, step: 1, interrupted: true, message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
  }, { surfaceOp: 'append' })
  let reads = 0
  h.ctx.sessionQuery.readSession = async () => {
    reads += 1
    if (reads === 1) {
      h.session.append('step/end', { turn: 1, step: 1 })
      h.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    }
    return { events: h.events.slice(), inheritedEventCount: 0 }
  }
  const preview = await h.preview('A')
  assert.equal(preview.ok, true)
  assert.equal(preview.text, 'A')
  assert.equal(reads, 1)
})

test('a preview retries when the stop cleanup lands after its first snapshot', async () => {
  const h = harness()
  h.session.append('turn/start', { turn: 1 })
  h.session.append('step/start', { turn: 1, step: 1 })
  h.session.append('user/message', {
    id: 'A', role: 'user', content: [{ type: 'text', text: 'A' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  h.session.append('assistant/message', {
    turn: 1, step: 1, interrupted: true, message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
  }, { surfaceOp: 'append' })
  const close = () => {
    h.session.append('step/end', { turn: 1, step: 1 })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  }
  let reads = 0
  h.ctx.sessionQuery.readSession = async () => {
    const events = h.events.slice()
    if (reads === 0) queueMicrotask(close)
    reads += 1
    return { events, inheritedEventCount: 0 }
  }
  const preview = await h.preview('A')
  assert.equal(preview.ok, true)
  assert.equal(preview.text, 'A')
  assert.equal(reads, 2)
})

test('a cross-origin or unmarked request is rejected before the route accesses the session', async () => {
  const h = harness(); const handler = h.routes.get(TRUNCATE_ROUTE)
  for (const headers of [{}, { 'x-dk-context-tree': '1', origin: 'https://other.example' }]) {
    const res = await handler(new Request('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }))
    assert.equal(res.status, 403)
  }
})
