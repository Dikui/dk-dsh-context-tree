import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plan from '../src/plan.js'
import { harness } from './route-harness.js'

// The package is optional for ordinary contributors. Run this file with DSH's
// own ASAR-aware Electron executable in Desktop, not a second live Host.
const require = createRequire(import.meta.url)
let installed
try {
  installed = require.resolve('@deepseek-ai/dsh-session', { paths: [process.env.DSH_INSTALL_DIR || process.cwd()] })
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}
const sessionTest = (name, fn) => test(name, { skip: installed ? false : 'installed DSH runtime unavailable' }, fn)

function fixture() {
  const { Session } = require(installed)
  const session = Session.create('rewind-in-memory')
  let turn = 0
  function input(text) {
    const pos = { turn: ++turn, step: 1 }
    session.append('turn/start', { turn })
    session.append('step/start', pos)
    if (turn === 1) session.append('system/message', {
      ...pos, message: { role: 'system', source: { kind: 'system-prompt' }, id: 'sys', content: [{ type: 'text', text: 'SYSTEM' }] },
    }, { surfaceOp: 'append' })
    const event = session.append('user/message', {
      id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      ...pos, stream: [], message: { id: `a${turn}`, role: 'assistant', source: { kind: 'model', model: 'stub', provider: 'stub' }, content: [{ type: 'text', text: `${text}-reply` }] },
    }, { surfaceOp: 'append' })
    session.append('step/end', pos)
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    return event
  }
  const rewind = seq => {
    const cut = plan.planRewind(session.snapshotEvents(), session.surface.nodes, seq)
    assert.equal(cut.kind, 'ok')
    return session.append(cut.type, cut.data, cut.options)
  }
  return { session, input, rewind, text: () => session.deriveMessages().map(m => m.content.map(b => b.text).join('')) }
}

sessionTest('rewind removes the target itself, retaining exactly its conversation prefix across subsequent rewinds', () => {
  const { session, input, rewind, text } = fixture()
  input('A')
  const b = input('B')
  rewind(b.seq)
  assert.deepEqual(text(), ['SYSTEM', 'A', 'A-reply'])
  input('C')
  rewind(input('D').seq)
  assert.deepEqual(text(), ['SYSTEM', 'A', 'A-reply', 'C', 'C-reply'])
  assert.deepEqual(plan.rewindMask(session.snapshotEvents()), { cutSeq: b.seq, turns: [2, 4], messageIds: ['u2', 'u4'] })
})

sessionTest('the preview, confirm and reload routes agree with the installed model projection', async () => {
  const { session, input, text } = fixture(), host = harness()
  host.ctx.sessions.get = id => id === 's' ? session : undefined
  host.ctx.sessionQuery.readSession = async () => ({ events: session.snapshotEvents(), inheritedEventCount: 0 })
  input('A')
  for (const [prompt, retained] of [['B', ['SYSTEM', 'A', 'A-reply']], ['D', ['SYSTEM', 'A', 'A-reply', 'C', 'C-reply']]]) {
    if (prompt === 'D') input('C')
    const { data: { id } } = input(prompt)
    const preview = await host.preview(id)
    assert.equal(preview.text, prompt); assert.deepEqual(preview.files, [])
    const response = await host.confirm(id, preview.previewToken)
    assert.equal(response.ok, true); assert.equal(response.text, prompt)
    assert.deepEqual(text(), retained)
    assert.deepEqual(await host.cut(), { ok: true, ...response.mask })
  }
})

async function localFileFixture(t) {
  const runtime = createRequire(installed)
  let LocalFileSystem
  try { ({ LocalFileSystem } = runtime('@deepseek-ai/dsh-fs-local')) } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    return t.skip('local DSH filesystem unavailable')
  }
  const { Context } = runtime('@deepseek-ai/cordis')
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rewind-fs-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fs = new LocalFileSystem(new Context(), { cwd: directory, diffBasisMaxBytes: 8192 })
  return { fs, directory }
}

sessionTest('a redirected parent cannot authorize deletion of an identically versioned file', async t => {
  const local = await localFileFixture(t)
  if (!local) return
  const { fs, directory } = local
  // Regression: a hard link gives the redirected entry identical bytes AND a
  // matching provider version, so even the guard cannot detect path redirection.
  for (const stage of ['before-preview', 'after-confirm']) {
    const original = join(directory, stage), other = join(directory, stage + '-other')
    await mkdir(original); await mkdir(other)
    const path = join(original, 'created'), otherPath = join(other, 'created')
    await fs.writeText(await fs.resolve(path), 'mine', { kind: 'createIfAbsent' })
    await link(path, otherPath)
    async function redirect() {
      await rename(original, original + '-saved')
      await symlink(other, original, 'dir')
    }
    const h = harness({ policy: { mode: 'workspace-write', workspaceRoot: directory }, flush: async () => {
      if (stage === 'after-confirm') await redirect()
      return true
    } })
    h.ctx.fs = fs
    h.turn(1, 'A', () => h.fileResult(1, path, { content: 'mine' }, 'create'))
    if (stage === 'before-preview') await redirect()
    const p = await h.preview('A')
    assert.equal(p.files[0].status, stage === 'after-confirm' ? 'ok' : 'blocked')
    const r = await h.confirm('A', p.previewToken, true)
    assert.notEqual(r.files[0].status, 'ok')
    assert.equal(await fs.readText(await fs.resolve(otherPath)), 'mine')
  }
})

sessionTest('confirmed deletion uses the local DSH provider and respects its version guard', async t => {
  const local = await localFileFixture(t)
  if (!local) return
  const { fs, directory } = local
  for (const race of [false, true]) {
    const path = join(directory, race ? 'race.txt' : 'created.txt'), target = await fs.resolve(path)
    assert.equal(target.displayPath, path)
    const { version } = await fs.writeText(target, 'mine\n', { kind: 'createIfAbsent' })
    const h = harness({ policy: { mode: 'workspace-write', workspaceRoot: directory }, flush: async () => {
      if (race) await fs.writeText(target, 'hand edited\n', { kind: 'replaceIfVersion', version })
      return true
    } })
    h.ctx.fs = fs
    h.turn(1, 'A', () => h.fileResult(1, path, { content: 'mine\n' }, 'create'))
    const preview = await h.preview('A')
    assert.equal(preview.files[0].status, 'ok')
    const confirmed = await h.confirm('A', preview.previewToken, true)
    assert.equal(confirmed.ok, true)
    if (race) {
      assert.equal(confirmed.files[0].reason, 'changed')
      assert.equal(await fs.readText(target), 'hand edited\n')
    } else {
      assert.equal(confirmed.files[0].status, 'ok')
      assert.equal(await fs.stat(target), undefined)
    }
  }
})

sessionTest('an existing legacy marker is masked by id without consuming a later retained branch', () => {
  const { session, input, rewind, text } = fixture()
  input('A')
  const b = input('B')
  session.append('user/message', { id: 'rewind-legacy', role: 'user', source: { kind: 'context-tree-rewind' }, content: [{ type: 'text', text: 'B' }] }, {
    surfaceOp: { op: 'replace', startSeq: b.seq, endSeq: b.seq + 1 }, sourceEventSeqs: [b.seq, b.seq + 1],
  })
  input('C')
  rewind(input('D').seq)
  // A legacy marker was already model-visible. Do not silently rewrite history
  // before the requested cut in an attempt to migrate that historical row.
  assert.deepEqual(text(), ['SYSTEM', 'A', 'A-reply', 'B', 'C', 'C-reply'])
  assert.deepEqual(plan.rewindMask(session.snapshotEvents()), { cutSeq: b.seq, turns: [2, 4], messageIds: ['u2', 'rewind-legacy', 'u4'] })
})

sessionTest('legacy numeric provenance may cite a retained head without masking its turn', () => {
  const { session, input } = fixture()
  input('A')
  const b = input('B')
  const [sys] = session.surface.nodes
  const head = session.append('system/message', session.snapshotEvents().find(e => e.seq === sys).data, {
    surfaceOp: { op: 'replace', startSeq: sys, endSeq: sys }, sourceEventSeqs: [sys],
  })
  const c = input('C')
  // Old producers filtered by numeric seq, so their legal sources could also
  // include a rewritten prefix node. DSH's splice never removed that node.
  session.append('user/message', { role: 'user', id: 'old', source: { kind: 'context-tree-rewind' }, content: [{ type: 'text', text: 'B' }] }, {
    surfaceOp: { op: 'replace', startSeq: b.seq, endSeq: c.seq + 1 },
    sourceEventSeqs: [head.seq, b.seq, b.seq + 1, c.seq, c.seq + 1],
  })
  assert.deepEqual(plan.rewindMask(session.snapshotEvents()), { cutSeq: b.seq, turns: [2, 3], messageIds: ['u2', 'u3', 'old'] })
})

sessionTest('nonmonotonic replacements keep the newer system head and mask the rewritten turn, not later seqs', () => {
  const { session, input, rewind, text } = fixture()
  const a = input('A')
  const b = input('B')
  const c = input('C')
  const [sys] = session.surface.nodes
  const sysEvent = session.snapshotEvents().find(e => e.seq === sys)
  session.append('system/message', { ...sysEvent.data, turn: 3 }, {
    surfaceOp: { op: 'replace', startSeq: sys, endSeq: sys }, sourceEventSeqs: [sys],
  })
  // A native checkpoint replaces C, after C's assistant event was logged. Its
  // extra citation of A is provenance, not a removed Chat row.
  session.append('user/message', {
    id: 'summary', role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'summary' }],
  }, { surfaceOp: { op: 'replace', startSeq: c.seq, endSeq: c.seq }, sourceEventSeqs: [a.seq, c.seq] })
  const marker = rewind(b.seq)
  assert.deepEqual(marker.sourceEventSeqs, [b.seq, b.seq + 1, marker.seq - 1, c.seq + 1])
  assert.deepEqual(text(), ['SYSTEM', 'A', 'A-reply'])
  assert.deepEqual(plan.rewindMask(session.snapshotEvents()), { cutSeq: b.seq, turns: [2, 3], messageIds: ['u2', 'u3'] })
})
