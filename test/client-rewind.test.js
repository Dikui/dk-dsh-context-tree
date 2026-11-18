import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// small/spec — preview-bound rewind contract. Load the shipped command just as
// the mask tests do: the plain-script module loader cannot import a testable ESM.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const command = source.match(/\/\* dc:rewind:start \*\/([\s\S]+?)\/\* dc:rewind:end \*\//)?.[1]
assert.ok(command, 'the shipped preview-bound rewind command must be available')
const runRewind = new Function(command + '\nreturn runRewind')()
const target = { sessionId: 'first', messageId: 'message' }
const files = [{ path: '/work/note', action: 'restore', status: 'ok' }]
const mask = { turns: [1], messageIds: ['message'] }
const previewToken = 'first preview'
const preview = { ok: true, text: 'hello', files, previewToken, markerMode: 'notice-v1' }
const committed = { ok: true, text: 'hello', mask }

// Replace the Host, confirmation decision, and page-side effects, not Chat or DOM.
function scenario(overrides = {}) {
  const requests = [], confirmations = [], drafts = [], masks = [], notices = []
  const options = {
    target, isCurrent: () => true, sameSession: () => true,
    preview: async () => preview,
    choose: async plan => { confirmations.push(plan); return plan.revertFiles },
    truncate: async body => { requests.push(body); return committed },
    setDraft: value => drafts.push(value), applyMask: value => masks.push(value),
    report: (key, details) => notices.push({ key, details }),
    ...overrides,
  }
  return { run: () => runRewind(options), requests, confirmations, drafts, masks, notices }
}

test('confirming the preview leaves even actionable files alone by default', async () => {
  const s = scenario()
  await s.run()
  assert.deepEqual(s.confirmations, [{ text: preview.text, files, revertFiles: false }])
  assert.deepEqual(s.requests, [{ ...target, revertFiles: false, previewToken, markerMode: 'notice-v1' }])
  assert.deepEqual(s.masks, [mask])
  assert.deepEqual(s.drafts, ['hello'])
})

for (const filePlans of [[], [{ ...files[0], action: 'already-absent' }], [{ ...files[0], status: 'blocked' }]]) {
  test(`no file changes can be requested for ${filePlans[0]?.status === 'blocked' ? 'blocked' : filePlans[0]?.action || 'empty'} plans`, async () => {
    const s = scenario({ preview: async () => ({ ...preview, files: filePlans }), choose: async () => true })
    await s.run()
    assert.equal(s.requests[0].revertFiles, false)
  })
}

// small/spec — consent to the fixed model-visible notice must match the Host protocol.
test('an absent or unknown notice mode cannot offer a rewind for confirmation', async () => {
  for (const markerMode of [undefined, 'notice-v2']) {
    const s = scenario({ preview: async () => ({ ...preview, markerMode }) })
    await s.run()
    assert.deepEqual([s.confirmations, s.requests], [[], []])
    assert.equal(s.notices[0].key, 'preview-unavailable')
  }
})

test('a tokenless Host cannot offer a rewind for confirmation', async () => {
  const { previewToken: _, ...withoutToken } = preview
  const s = scenario({ preview: async () => withoutToken })
  await s.run()
  assert.deepEqual(s.confirmations, [])
  assert.deepEqual(s.requests, [])
  assert.equal(s.notices[0].key, 'preview-unavailable')
})

for (const reason of ['preview-stale', 'flush-failed']) {
  test(`${reason} reports the Host outcome without applying a draft or retrying`, async () => {
    const s = scenario({ truncate: async body => { s.requests.push(body); return { ok: false, reason } } })
    await s.run()
    assert.equal(s.confirmations.length, 1)
    assert.equal(s.requests.length, 1)
    assert.deepEqual(s.masks, [])
    assert.deepEqual(s.drafts, [])
    assert.equal(s.notices[0].key, reason)
  })
}

test('flush-failed preserves the draft but reflects a confirmed in-memory cut', async () => {
  const s = scenario({ truncate: async () => ({ ok: false, text: 'hello', mask, reason: 'flush-failed' }) })
  await s.run()
  assert.deepEqual(s.masks, [mask])
  assert.deepEqual(s.drafts, [])
  assert.equal(s.notices[0].key, 'flush-failed')
})

test('only explicit file opt-in sends true, with skipped paths reported after the cut', async () => {
  const skipped = { path: files[0].path, status: 'failed', reason: 'changed' }
  const s = scenario({
    choose: async () => true,
    truncate: async body => { s.requests.push(body); return { ...committed, files: [skipped] } },
  })
  await s.run()
  assert.deepEqual(s.requests, [{ ...target, revertFiles: true, previewToken, markerMode: 'notice-v1' }])
  assert.deepEqual(s.masks, [mask])
  assert.deepEqual(s.notices, [{ key: 'files-skipped', details: [skipped] }])
})

// small/regression — confirmation commits to a session, not the mounted button.
for (const switched of [false, true]) {
  test(`a confirmed rewind ${switched ? 'never applies to a different session' : 'survives losing its row in the same session'}`, async () => {
    const started = Promise.withResolvers(), result = Promise.withResolvers()
    const skipped = { path: files[0].path, status: 'failed', reason: 'changed' }
    let row = true, sameSession = true
    const s = scenario({
      isCurrent: () => row && sameSession, sameSession: () => sameSession, choose: async () => true,
      truncate: () => { started.resolve(); return result.promise },
    })
    const pending = s.run()
    await started.promise
    row = false
    sameSession = !switched
    result.resolve({ ...committed, files: [skipped] })
    await pending
    assert.deepEqual([s.masks, s.drafts, s.notices], switched ? [[], [], []] : [
      [mask], ['hello'], [{ key: 'files-skipped', details: [skipped] }],
    ])
  })
}

// small/regression — fake the Host cut read and the selected Session's retention
// source. No Chat component or session-wide renderer is replaced in these tests.
function mountedSession(cuts) {
  const factory = source.match(/\/\* dc:session:start \*\/([\s\S]+?)\/\* dc:session:end \*\//)?.[1]
  assert.ok(factory, 'shipped session lifetime must be available')
  const masks = [], reads = [], listeners = new Set()
  let selected = true
  const owner = new Function(factory + '\nreturn createRewindSession')()({
    readCut: id => { reads.push(id); return cuts.shift().promise },
    mask: { maskRanges: ranges => masks.push(ranges), clear: () => masks.push(null) },
    mainView: () => ({ getSnapshot: () => ({ retainedBy: { mainView: Number(selected) } }),
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } }),
  })
  return { owner, reads, masks, switchAway() { selected = false; for (const fn of listeners) fn() } }
}

test('a remounted Chat recovers a failed cut, sharing each read across its rows', async () => {
  const first = Promise.withResolvers(), second = Promise.withResolvers(), third = Promise.withResolvers()
  const s = mountedSession([first, second, third])
  const rowA = s.owner.mount('first'), rowB = s.owner.mount('first')
  assert.deepEqual(s.reads, ['first'])
  first.reject(new Error('offline'))
  await rowA.ready
  rowA.release(); rowB.release()
  const rowC = s.owner.mount('first'), rowD = s.owner.mount('first')
  second.resolve({ ok: true, ...mask })
  await rowC.ready
  assert.deepEqual(s.masks.at(-1), { ok: true, ...mask })
  const rowE = s.owner.mount('first')
  assert.deepEqual(s.reads, ['first', 'first'])
  rowC.release(); rowD.release(); rowE.release()
  const nextView = s.owner.mount('first')
  third.resolve({ ok: true, turns: [1, 2], messageIds: [] })
  await nextView.ready
  assert.deepEqual(s.masks.at(-1).turns, [1, 2])
})

test('switching to an empty session retires even detached commands and in-flight cut reads', async () => {
  const cut = Promise.withResolvers()
  const s = mountedSession([cut])
  const old = s.owner.mount('first')
  old.release()
  assert.equal(old.sameSession(), true, 'a lost row is not a session switch')
  s.switchAway() // The destination has no user row on which to mount a button.
  assert.equal(old.sameSession(), false)
  cut.resolve({ ok: true, ...mask })
  await old.ready
  assert.equal(s.masks.at(-1), null)
})

test('an older cut read cannot overwrite the mask of a confirmed rewind', async () => {
  const cut = Promise.withResolvers()
  const s = mountedSession([cut])
  const old = s.owner.mount('first')
  old.release()
  old.applyMask(mask)
  cut.resolve({ ok: true, turns: [], messageIds: [] })
  await old.ready
  assert.deepEqual(s.masks.at(-1), mask)
})

test('a lost truncate response leaves the result explicitly unconfirmed', async () => {
  const s = scenario({ truncate: async () => { throw new Error('offline') } })
  await s.run()
  assert.deepEqual([s.masks, s.drafts], [[], []])
  assert.equal(s.notices[0].key, 'rewind-unconfirmed')
})

test('incomplete file receipts leave the opted-in files explicitly unconfirmed', async () => {
  const s = scenario({ choose: async () => true, truncate: async () => ({ ...committed, files: [] }) })
  await s.run()
  assert.deepEqual(s.drafts, ['hello'])
  assert.equal(s.notices[0].key, 'files-unconfirmed')
})

test('a draft error after a successful cut does not misreport rewind failure', async () => {
  const s = scenario({ setDraft: () => { throw new Error('composer unavailable') } })
  await s.run()
  assert.deepEqual(s.masks, [mask])
  assert.equal(s.notices[0].key, 'draft-failed')
})

// Exercise the shipped module-loader entry. The registry models DSH's duplicate
// rejection and scoped unregister; the DOM stub represents preinstalled styles.
function clientLoader(previous = new Map()) {
  const registry = previous
  const locale = {
    register(ns, messages) {
      if (registry.has(ns)) throw new Error(`locale namespace ${ns} already registered`)
      registry.set(ns, messages)
      return () => registry.delete(ns)
    },
    bind: ns => key => registry.get(ns)?.zh[key] ?? key,
  }
  return () => {
    const disposers = []
    let slot, plugin
    const slots = { inject: (_, register) => register(), register: (entry, render) => {
      slot = { ...entry, render }; return () => { slot = null }
    } }
    const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(() => ({ createElement: (_, props) => props })) } } }
    const document = { getElementById: () => ({}), querySelectorAll: () => [] }
    new Function('window', 'document', source)(window, document)
    plugin.apply({ locale, slots, effect: register => disposers.push(register()) })
    return { name: plugin.name, slot, dispose: () => disposers.reverse().forEach(fn => fn()) }
  }
}

// small/regression — a prior unscoped version can leave its namespace occupied.
test('hot-loading over a legacy dictionary allows repeated activation and disposal', () => {
  const legacy = 'dk-dsh-context-tree', ns = 'dk-dsh-context-tree.client'
  const registry = new Map([[legacy, { zh: { rewind: '旧版' } }]])
  const activate = clientLoader(registry)
  for (let i = 0; i < 2; i++) {
    const client = activate()
    assert.equal(client.name, legacy)
    assert.equal(client.slot.locale, ns)
    assert.equal(client.slot.render({}).tr('rewind'), '回到这里')
    client.dispose()
    assert.deepEqual([...registry.keys()], [legacy])
  }
})

// small/spec — both supported locales disclose the exact model-visible notice
// before consent, whether the preview has file changes or not.
test('confirmation copy discloses the fixed notice without promising a new model request', () => {
  const registry = new Map()
  const client = clientLoader(registry)()
  const { en, zh } = registry.get(client.slot.locale)
  for (const key of ['confirmBody', 'confirmBodyNoFiles']) {
    for (const text of [en[key], zh[key]]) assert.ok(text.includes('Conversation rewound.'))
    assert.match(en[key], /model will see/i)
    assert.match(en[key], /does not start a model request/i)
    assert.match(zh[key], /模型会看到/)
    assert.match(zh[key], /不会单独发起模型请求/)
  }
  client.dispose()
})

// small/regression — backend-specific error codes need a readable localized label.
test('unknown file errors retain the diagnostic code alongside a localized explanation', () => {
  const format = source.match(/function reasonText\(tr, reason\) \{[\s\S]+?\n    \}/)[0]
  const reason = new Function('messages', format + '\nreturn reasonText')({ en: {} })
  assert.equal(reason(() => '文件无法还原', 'EACCES'), '文件无法还原 (EACCES)')
})

// small/regression — before confirmation only the initiating row may proceed.
for (const stage of ['preview', 'choose']) {
  test(`losing the row while awaiting ${stage} cancels the unconfirmed rewind`, async () => {
    const started = Promise.withResolvers(), result = Promise.withResolvers()
    let row = true
    const s = scenario({ isCurrent: () => row, [stage]: () => { started.resolve(); return result.promise } })
    const pending = s.run()
    await started.promise
    row = false
    result.resolve(stage === 'preview' ? preview : true)
    await pending
    assert.deepEqual([s.requests, s.confirmations, s.notices], [[], [], []])
  })
}

test('cancelling a preview never sends truncate', async () => {
  const s = scenario({ choose: async () => null })
  await s.run()
  assert.deepEqual(s.requests, [])
  assert.deepEqual(s.drafts, [])
})
