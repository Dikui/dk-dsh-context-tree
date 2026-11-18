import test from 'node:test'
import assert from 'node:assert/strict'
import { TRUNCATE_ROUTE } from '../index.js'
import { harness } from './route-harness.js'

test('one confirmation replaces only the chosen message surface suffix and returns its draft', async () => {
  const h = harness()
  h.turn(1, 'A'); const start = h.turn(2, 'B')
  const nodes = h.session.surface.nodes.slice()
  const p = await h.preview('B')
  assert.equal(p.ok, true); assert.equal(typeof p.previewToken, 'string')
  const length = h.events.length, r = await h.confirm('B', p.previewToken)
  assert.equal(r.ok, true); assert.equal(r.text, 'B'); assert.equal(h.events.length, length + 1)
  const marker = h.events.at(-1)
  assert.deepEqual(marker.surfaceOp, { op: 'replace', startSeq: start, endSeq: nodes.at(-1) })
  assert.deepEqual(marker.sourceEventSeqs, nodes.slice(nodes.indexOf(start)))
  assert.deepEqual(r.mask.messageIds, ['B']); assert.deepEqual(r.mask.turns, [2])
  assert.deepEqual(await h.cut(), { ok: true, ...r.mask })
  assert.equal((await h.confirm('B', p.previewToken)).ok, false)
  assert.equal(h.events.length, length + 1)
})

test('after cutting B, sending C and D, cutting D does not hide C', async () => {
  const h = harness(); h.turn(1, 'A'); h.turn(2, 'B')
  await h.confirm('B', (await h.preview('B')).previewToken)
  const c = h.turn(3, 'C'), d = h.turn(4, 'D')
  const r = await h.confirm('D', (await h.preview('D')).previewToken)
  assert.equal(r.ok, true); assert.equal(h.events.at(-1).surfaceOp.startSeq, d)
  assert.ok(h.session.surface.nodes.includes(c)); assert.deepEqual(r.mask.messageIds, ['B', 'D'])
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

test('an open turn, or a message already off-surface, cannot be previewed', async () => {
  const h = harness(); h.turn(1, 'A'); h.turn(2, 'B')
  await h.confirm('B', (await h.preview('B')).previewToken)
  assert.equal((await h.preview('B')).reason, 'not-surface-node')
  h.session.append('turn/start', { turn: 3 }); assert.equal((await h.preview('A')).reason, 'session-busy')
})

test('a cross-origin or unmarked request is rejected before the route accesses the session', async () => {
  const h = harness(); const handler = h.routes.get(TRUNCATE_ROUTE)
  for (const headers of [{}, { 'x-dk-context-tree': '1', origin: 'https://other.example' }]) {
    const res = await handler(new Request('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }))
    assert.equal(res.status, 403)
  }
})
