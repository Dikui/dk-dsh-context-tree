import test from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './route-harness.js'

function fixture(options = {}) {
  const files = new Map([['/w/new', { version: 'v1', content: 'created\n' }], ['/w/app', { version: 'v2', content: 'after' }]])
  const h = harness({ files, ...options })
  h.turn(1, 'A', () => {
    h.fileResult(1, '/w/new', { content: 'created\n' }, 'create')
    h.fileResult(1, '/w/app', { content: 'after' }, 'update', [])
  })
  return h
}

test('preview is read-only; missing overwrite history is not presented as a successful restore', async () => {
  const h = fixture(), n = h.events.length, p = await h.preview('A')
  assert.equal(p.ok, true); assert.equal(typeof p.previewToken, 'string')
  assert.deepEqual(p.files.map(f => [f.label, f.action, f.status, f.reason]), [
    ['new', 'delete', 'ok', undefined], ['app', 'restore', 'conflict', 'unproven'],
  ])
  assert.equal(h.mutations.length, 0); assert.equal(h.events.length, n)
})

test('preview of a created then edited file shows the whole current text being deleted', async () => {
  const path = '/w/new', content = 'one\nTWO'
  const h = harness({ files: new Map([[path, { version: 'v2', content }]]) })
  h.turn(1, 'A', () => {
    h.fileResult(1, path, { content: 'one\ntwo\n' }, 'create')
    h.fileResult(1, path, { old_string: 'two\n', new_string: 'TWO' }, undefined, [
      { path, oldText: 'one\ntwo', newText: 'one\nTWO' },
    ])
  })
  const p = await h.preview('A')
  assert.equal(p.files[0].status, 'ok')
  assert.deepEqual(p.files[0].diffs, [{ path, oldText: null, newText: content }])
})

test('a create after an opaque mutation in the selected turn does not prove the file was absent at the boundary', async () => {
  const path = '/w/name', content = 'replacement', h = harness({ files: new Map([[path, { version: 'v1', content }]]) })
  h.turn(1, 'A', () => {
    const call = h.session.append('tool/call', { turn: 1, step: 1, callId: 'opaque', name: 'bash', arguments: '{}' })
    h.session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'opaque', source: { kind: 'tool', callId: 'opaque' } } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    h.fileResult(1, path, { content }, 'create')
  })
  const p = await h.preview('A')
  assert.equal(p.files[0].reason, 'unproven')
  await h.confirm('A', p.previewToken, true)
  assert.deepEqual(h.mutations, [])
})

// Regression: a fork presents parent history as part of its surface, but the
// inherited prefix is not evidence of a file action performed in this session.
test('rewinding an inherited message deletes only files whose original call and result are owned', async () => {
  const paths = ['/w/parent', '/w/child']
  for (const ownership of ['after-turn', 'split-call', 'missing', 'invalid']) {
    const h = harness({ files: new Map(paths.map(path => [path, { version: 'v1', content: 'mine' }])) })
    let parentResult
    h.turn(1, 'A', () => { parentResult = h.fileResult(1, paths[0], { content: 'mine' }, 'create') })
    const afterTurn = h.session.seq
    h.turn(2, 'B', () => h.fileResult(2, paths[1], { content: 'mine' }, 'create'))
    const boundaries = { 'after-turn': afterTurn, 'split-call': parentResult.seq, missing: undefined, invalid: -1 }
    h.ctx.sessionQuery.readSession = async () => ({ events: h.events.slice(), inheritedEventCount: boundaries[ownership] })
    const p = await h.preview('A')
    const own = ownership === 'after-turn' || ownership === 'split-call' ? [paths[1]] : []
    assert.equal(p.ok, true); assert.deepEqual(p.files.map(f => f.path), own, ownership)
    const r = await h.confirm('A', p.previewToken, true)
    assert.equal(r.ok, true); assert.deepEqual(h.mutations.map(m => m.path), own, ownership)
  }
})

test('only an opted-in, version-guarded delete is applied after confirmed flush', async () => {
  for (const optIn of [false, true]) {
    let flushed = false
    const h = fixture({ flush: async () => { flushed = true; return true } }), p = await h.preview('A')
    const response = await h.confirm('A', p.previewToken, optIn)
    assert.equal(response.ok, true); assert.equal(flushed, true)
    if (optIn) {
      assert.deepEqual(h.mutations, [{ action: 'delete', path: '/w/new', expected: { version: 'v1' }, policy: { mode: 'workspace-write', workspaceRoot: '/w' } }])
      assert.equal(response.files[1].reason, 'unproven')
    } else { assert.deepEqual(h.mutations, []); assert.equal(response.files, undefined) }
  }
})

test('an opted-in preview cannot be enlarged or applied to a different file version', async () => {
  for (const change of ['file', 'turn']) {
    const h = fixture(), p = await h.preview('A')
    if (change === 'file') h.files.get('/w/new').version = 'edited'
    else h.turn(2, 'B', () => h.fileResult(2, '/w/other', { content: 'later' }, 'create'))
    const n = h.events.length, r = await h.confirm('A', p.previewToken, true)
    assert.equal(r.reason, 'preview-stale'); assert.equal(h.events.length, n); assert.equal(h.mutations.length, 0)
  }
})

// Regression: neither danger-full-access nor extra writable roots widen a rewind.
// Both observations and deletion must stay under the *current* workspace root.
test('file opt-in respects the resolved workspace even with full access', async () => {
  const paths = ['/w/new', '/extra/new']
  for (const changedRoot of [false, true]) {
    const policy = { mode: 'danger-full-access', workspaceRoot: '/w', additionalWritableRoots: ['/extra'] }
    const files = new Map(paths.map(path => [path, { version: 'v1', content: 'new' }]))
    const h = harness({ files, policy, flush: async () => { if (changedRoot) policy.workspaceRoot = '/extra'; return true } })
    h.turn(1, 'A', () => { for (const path of paths) h.fileResult(1, path, { content: 'new' }, 'create') })
    const p = await h.preview('A')
    assert.deepEqual(p.files.map(f => [f.path, f.status]), [['/w/new', 'ok'], ['/extra/new', 'blocked']])
    const r = await h.confirm('A', p.previewToken, true)
    assert.equal(r.ok, true)
    assert.deepEqual(h.mutations.map(m => m.path), changedRoot ? [] : ['/w/new'])
    assert.equal(h.files.has('/extra/new'), true)
  }
})

test('a disk change does not prevent a conversation-only confirmation', async () => {
  const h = fixture(), p = await h.preview('A')
  h.files.set('/w/new', { version: 'edited', content: 'new user edit' })
  const r = await h.confirm('A', p.previewToken, false)
  assert.equal(r.ok, true); assert.deepEqual(h.mutations, [])
})

// Regression: stat can be stale; only a bounded provider read can prevent
// buffering a file which grew since stat. Missing capability must not fall back.
test('the provider enforces the 2 MiB limit on the actual read during preview and confirmation', async () => {
  const path = '/w/new', h = harness({ files: new Map([[path, { version: 'v1', content: 'small' }]]) })
  h.turn(1, 'A', () => h.fileResult(1, path, { content: 'small' }, 'create'))
  h.ctx.fs.stat = async () => ({ type: 'file', version: 'v1', size: 5 })
  h.files.get(path).content = Buffer.alloc(2 * 1024 * 1024 + 1)
  const p = await h.preview('A')
  assert.equal(p.files[0].reason, 'too-large')
  assert.equal((await h.confirm('A', p.previewToken, true)).files[0].reason, 'too-large')
  assert.deepEqual(h.mutations, [])
})

test('replacement characters and BOM stripping cannot disguise different physical bytes', async () => {
  for (const [bytes, logged] of [[Buffer.from([0xf0, 0x9f, 0x98]), '\uFFFD'], [Buffer.from('\uFEFFmine'), 'mine']]) {
    const path = '/w/new', h = harness({ files: new Map([[path, { version: 'v1', content: bytes }]]) })
    h.turn(1, 'A', () => h.fileResult(1, path, { content: logged }, 'create'))
    const p = await h.preview('A')
    assert.notEqual(p.files[0].status, 'ok')
    await h.confirm('A', p.previewToken, true)
    assert.deepEqual(h.mutations, [])
  }
})

test('older provider or policy without identity, bounded reads, or a workspace root cannot delete', async () => {
  for (const missing of ['processPath', 'readBytes', 'workspaceRoot']) {
    const h = missing === 'workspaceRoot' ? fixture({ policy: { mode: 'danger-full-access' } }) : fixture()
    if (missing !== 'workspaceRoot') delete h.ctx.fs[missing]
    const p = await h.preview('A')
    assert.equal(p.files[0].status, 'blocked', missing)
    await h.confirm('A', p.previewToken, true)
    assert.deepEqual(h.mutations, [])
  }
})

test('a turn arriving during confirm file I/O invalidates the live snapshot before append', async () => {
  const h = fixture(), p = await h.preview('A'), readBytes = h.ctx.fs.readBytes
  let once = true
  h.ctx.fs.readBytes = async (...args) => { if (once) { once = false; h.turn(2, 'B') } return readBytes(...args) }
  assert.equal((await h.confirm('A', p.previewToken, true)).reason, 'preview-stale')
  assert.equal(h.events.at(-1).type, 'turn/end'); assert.equal(h.mutations.length, 0)
})

test('flush errors and the absence of any durability listener leave files untouched', async () => {
  for (const flush of [async () => false, async () => { throw new Error('disk full') }]) {
    const h = fixture({ flush }), p = await h.preview('A'), n = h.events.length
    const r = await h.confirm('A', p.previewToken, true)
    assert.equal(r.ok, false); assert.equal(r.reason, 'flush-failed'); assert.equal(h.events.length, n + 1); assert.equal(h.mutations.length, 0)
  }
})

test('guarded deletion rejects a concurrent edit after validation; no raw-path fallback', async () => {
  const h = fixture({ flush: async () => { h.files.set('/w/new', { version: 'v3', content: 'hand edited' }); return true } })
  const r = await h.confirm('A', (await h.preview('A')).previewToken, true)
  assert.equal(r.ok, true); assert.equal(r.files[0].status, 'failed'); assert.equal(r.files[0].reason, 'changed'); assert.equal(h.mutations.length, 0)
})

test('unsupported deletion, unreadable byte basis, and a read-only policy fail closed', async () => {
  for (const caseName of ['unsupported', 'unproven', 'sandbox']) {
    const h = caseName === 'sandbox' ? fixture({ policy: { mode: 'read-only' } }) : fixture()
    if (caseName === 'unsupported') h.ctx.fs.deleteFile = undefined
    if (caseName === 'unproven') {
      const stat = h.ctx.fs.stat
      h.ctx.fs.stat = async target => { const info = await stat(target); return { ...info, size: info.size + 3 } }
    }
    const p = await h.preview('A')
    assert.equal(p.files[0].reason, caseName)
    const r = await h.confirm('A', p.previewToken, true)
    assert.notEqual(r.files[0].status, 'ok'); assert.equal(h.mutations.length, 0)
  }
})
