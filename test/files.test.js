import test from 'node:test'
import assert from 'node:assert/strict'

import { collectFileChanges, groupByPath, planFileRevert } from '../src/files.js'

/** Build a raw session event. */
function event(seq, type, data, surfaceOp) {
  return { seq, type, time: 0, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) }
}

/** A `tool/call` event with JSON arguments. */
function call(seq, callId, name, args, turn = 1) {
  return event(seq, 'tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) })
}

/** A `tool/result` event carrying presentation metadata. */
function result(seq, callId, meta, isError = false, turn = 1) {
  const entry = event(seq, 'tool/result', {
    turn,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [],
      isError,
      id: `result-${seq}`,
    },
    meta,
  }, 'append')
  return { ...entry, sourceEventSeqs: [seq - 1] }
}

/** V4 rewrites one current result, changing only its model-visible content. */
function rewrite(seq, previous, extraSources = []) {
  return { ...previous, seq,
    data: { ...previous.data, message: { ...previous.data.message, content: [{ type: 'text', text: `abridged ${seq}` }] } },
    surfaceOp: { op: 'replace', startSeq: previous.seq, endSeq: previous.seq },
    sourceEventSeqs: [previous.seq, ...extraSources],
  }
}

/** One recorded hunk. */
function hunk(oldText, newText, path = '/w/f.txt') {
  return { path, oldText, newText }
}

test('collectFileChanges exposes successful native changes but not reads or replayed results', () => {
  const edit = result(6, 'c-edit', { path: '/w/f.txt', diffs: [hunk('old', 'new')] })
  const events = [
    call(1, 'c-read', 'read', { file_path: '/w/read.txt' }),
    result(2, 'c-read', { path: '/w/read.txt', offset: 1, lines: 3, totalLines: 3, lang: 'text' }),
    call(3, 'c-write', 'write', { file_path: '/w/new.txt', content: 'hello' }),
    result(4, 'c-write', { operation: 'create', path: '/w/new.txt', diffs: [] }),
    call(5, 'c-edit', 'edit', { file_path: '/w/f.txt', old_string: 'old', new_string: 'new' }),
    edit, rewrite(7, edit),
    call(8, 'c-fail', 'write', { file_path: '/w/f.txt', content: 'x' }),
    result(9, 'c-fail', { operation: 'update', path: '/w/f.txt', diffs: [hunk('a', 'b')] }, true),
  ]

  const changes = collectFileChanges(events, 1)

  assert.deepEqual(changes.map(change => [change.seq, change.operation, change.tool]), [
    [4, 'create', 'write'],
    [6, 'edit', 'edit'],
  ])
  assert.equal(changes[0].args.content, 'hello')
  assert.deepEqual(changes[1].diffs, [hunk('old', 'new')])
})

// Regression: use the live positional suffix, not the rewrite's documentary citations.
test('a rewritten create keeps its native evidence without including an extra cited file', () => {
  const path = '/w/new', keep = '/w/retained'
  const prompt = (seq, id) => event(seq, 'user/message', { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] }, 'append')
  const original = result(11, 'new', { path, operation: 'create', diffs: [] }, false, 2)
  const abridged = rewrite(14, original, [4])
  const events = [
    event(0, 'turn/start', { turn: 1 }), event(1, 'step/start', { turn: 1, step: 1 }), prompt(2, 'A'),
    call(3, 'kept', 'write', { file_path: keep, content: 'retained' }),
    result(4, 'kept', { path: keep, operation: 'create', diffs: [] }),
    event(5, 'step/end', { turn: 1, step: 1 }), event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(7, 'turn/start', { turn: 2 }), event(8, 'step/start', { turn: 2, step: 1 }), prompt(9, 'B'),
    call(10, 'new', 'write', { file_path: path, content: 'new' }, 2), original,
    event(12, 'step/end', { turn: 2, step: 1 }), event(13, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    abridged, rewrite(15, abridged, [4]),
  ]
  // Both rewrites cite retained result 4, but neither splices its position.
  const groups = groupByPath(collectFileChanges(events, -1, new Set([9, 15]), 0))
  assert.deepEqual(groups.map(group => group.path), [path])
  assert.deepEqual(planFileRevert(groups[0], 'new'), { action: 'delete', status: 'ok' })
})

// A generic replacement can shadow a mutation inside the cut. Citing that
// history from a later tool rewrite neither offers it nor erases its veto.
test('a rewritten result does not revive an earlier shadowed write in the same cut', () => {
  const path = '/w/new'
  const earlier = result(4, 'old', { path, operation: 'update', diffs: [] })
  const original = result(7, 'new', { path, operation: 'create', diffs: [] })
  const checkpoint = { ...event(5, 'user/message', { id: 'checkpoint', role: 'user', source: { kind: 'compact-checkpoint' },
    content: [{ type: 'text', text: 'summary' }] }, { op: 'replace', startSeq: 4, endSeq: 4 }), sourceEventSeqs: [4] }
  const events = [event(0, 'turn/start', { turn: 1 }), event(1, 'step/start', { turn: 1, step: 1 }),
    event(2, 'user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }, 'append'),
    call(3, 'old', 'write', { file_path: path, content: 'overwritten' }), earlier, checkpoint,
    call(6, 'new', 'write', { file_path: path, content: 'new' }), original,
    event(8, 'step/end', { turn: 1, step: 1 }), event(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), rewrite(10, original, [4])]
  const changes = collectFileChanges(events, -1, new Set([2, 5, 10]), 0)
  assert.deepEqual(changes.map(change => change.seq), [7])
  assert.equal(planFileRevert(groupByPath(changes)[0], 'new').reason, 'unproven')
})

// A child can select an inherited prompt, but rewriting text is not a new mutation.
test('only the owner of both original call and result can offer a rewritten create', () => {
  const path = '/w/mine'
  const prompt = event(2, 'user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'test' }] }, 'append')
  const original = result(4, 'new', { path, operation: 'create', diffs: [] })
  const events = [event(0, 'turn/start', { turn: 1 }), event(1, 'step/start', { turn: 1, step: 1 }), prompt,
    call(3, 'new', 'write', { file_path: path, content: 'mine' }), original,
    event(5, 'step/end', { turn: 1, step: 1 }), event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), rewrite(7, original)]
  const paths = inherited => collectFileChanges(events, -1, new Set([2, 7]), inherited).map(change => change.path)
  assert.deepEqual(paths(3), [path]) // prompt is inherited, call and result are not
  assert.deepEqual(paths(4), []) // a child-side result does not own the parent call
  assert.deepEqual(paths(5), []) // both are inherited, the rewrite alone belongs to the child
})

test('native source seq, not a later reuse of the same callId, supplies create content', () => {
  const path = '/w/f.txt'
  const changes = collectFileChanges([
    call(1, 'shared', 'write', { file_path: path, content: 'created' }),
    result(2, 'shared', { path, operation: 'create', diffs: [] }),
    call(3, 'shared', 'write', { file_path: '/w/other.txt', content: 'independent' }),
    result(4, 'shared', { path: '/w/other.txt', operation: 'create', diffs: [] }),
  ], 0)
  assert.deepEqual(planFileRevert(groupByPath(changes)[0], 'independent'), { action: 'delete', status: 'conflict', reason: 'changed' })
  assert.equal(changes[0].callSeq, 1)
})

// Regression: only corroborated native file operations belong in the preview.
test('an external or uncorroborated result is a barrier, not a preview path', () => {
  const path = '/w/f.txt'
  const creation = [call(1, 'c', 'write', { file_path: path, content: 'mine' }),
    result(2, 'c', { path, operation: 'create', diffs: [] })]
  const other = '/w/other.txt'
  const meta = { path: other, operation: 'create', diffs: [] }
  const args = { file_path: other, content: 'other' }
  for (const name of ['foreign-tool', 'write']) {
    const later = result(4, 'later', meta)
    if (name === 'write') delete later.sourceEventSeqs
    const groups = groupByPath(collectFileChanges([...creation, call(3, 'later', name, args), later], 0))
    assert.deepEqual(groups.map(g => g.path), [path])
    assert.equal(planFileRevert(groups[0], 'mine').reason, 'unproven')
  }
})

test('malformed native create evidence never authorizes delete', () => {
  const path = '/w/f.txt'
  const meta = { path, operation: 'create', diffs: [] }
  const args = { file_path: path, content: 'mine' }
  const attempt = (events) => planFileRevert(groupByPath(collectFileChanges(events, 0))[0], 'mine')
  assert.equal(attempt([call(1, 'c', 'edit', args), result(2, 'c', meta)]).reason, 'unproven')
  const malformed = call(1, 'c', 'write', args)
  malformed.data.arguments = '{invalid'
  assert.equal(attempt([malformed, result(2, 'c', meta)]).reason, 'unproven')
})

test('collectFileChanges ignores results at or before the cut', () => {
  const events = [
    call(1, 'c', 'write', { file_path: '/w/f.txt', content: 'x' }),
    result(2, 'c', { operation: 'create', path: '/w/f.txt', diffs: [] }),
  ]
  assert.deepEqual(collectFileChanges(events, 2), [])
})

test('a dropped later mutation is a barrier even if the remaining text equals the create', () => {
  const path = '/w/f.txt'
  const creation = [call(1, 'c', 'write', { file_path: path, content: 'mine' }),
    result(2, 'c', { path, operation: 'create', diffs: [] })]
  for (const later of [
    [call(3, 'e', 'edit', { file_path: path }), result(4, 'e', { path, diffs: [] })],
    [call(3, 'e', 'edit', { file_path: path }), result(4, 'e', { path })],
    [event(4, 'tool/ptc-dispatch', { name: 'write', meta: { path, operation: 'update', diffs: [] } })],
    [call(3, 'p', 'apply_patch', {}), result(4, 'p', { stopped: false, diffs: [] })],
  ]) {
    const selected = collectFileChanges([...creation, ...later], -1, new Set([0, 2]), 0)
    assert.deepEqual(planFileRevert(groupByPath(selected)[0], 'mine'), { action: 'delete', status: 'conflict', reason: 'unproven' })
  }
})

test('an earlier possible removal inside the suffix prevents treating create as absence at the cut', () => {
  const path = '/w/f.txt'
  const creation = [call(7, 'c', 'write', { file_path: path, content: 'mine' }),
    result(8, 'c', { path, operation: 'create', diffs: [] })]
  const before = [call(3, 'b', 'bash', {}), result(4, 'b', {})]
  const boundary = new Set([2, 8])
  const selectedPlan = (prefix, selected) => planFileRevert(groupByPath(collectFileChanges([...prefix, ...creation], -1, selected, 0))[0], 'mine')
  assert.equal(selectedPlan(before, boundary).reason, 'unproven')
  assert.deepEqual(selectedPlan(before, new Set([6, 8])), { action: 'delete', status: 'ok' })
  for (const prefix of [
    [event(5, 'tool/ptc-dispatch', { name: 'edit', meta: { path } })],
    [call(5, 'q', 'write', { file_path: path, content: 'first' }), result(6, 'q', { path, operation: 'create', diffs: [] })],
    [call(5, 'q', 'bash', {})],
  ]) assert.equal(selectedPlan(prefix, boundary).reason, 'unproven')
})

test('a later valid edit cannot heal an intervening unselected PTC mutation', () => {
  const path = '/w/f.txt'
  const group = groupByPath(collectFileChanges([
    call(1, 'w', 'write', { file_path: path, content: 'mine' }), result(2, 'w', { path, operation: 'create', diffs: [] }),
    event(3, 'tool/ptc-dispatch', { name: 'write', meta: { path } }),
    call(4, 'e', 'edit', { file_path: path, old_string: 'mine', new_string: 'later' }),
    result(5, 'e', { path, diffs: [hunk('mine', 'later')] }),
  ], 0))[0]
  assert.equal(planFileRevert(group, 'later').reason, 'unproven')
})

test('groupByPath keeps first-seen order and marks created files', () => {
  const changes = [
    { path: '/w/a.txt', operation: 'create', diffs: [], args: { content: 'a' } },
    { path: '/w/b.txt', operation: 'edit', diffs: [hunk('b', 'B', '/w/b.txt')] },
    { path: '/w/a.txt', operation: 'edit', diffs: [hunk('a', 'A', '/w/a.txt')] },
  ]
  const groups = groupByPath(changes)

  assert.deepEqual(groups.map(group => group.path), ['/w/a.txt', '/w/b.txt'])
  assert.equal(groups[0].createdAfterCut, true)
  assert.equal(groups[1].createdAfterCut, false)
})

test('duplicate creations and subsequent full overwrites do not widen delete permission', () => {
  const path = '/w/f.txt'
  for (const operation of ['create', 'update']) {
    const group = groupByPath(collectFileChanges([
      call(1, 'c', 'write', { file_path: path, content: 'same' }), result(2, 'c', { path, operation: 'create', diffs: [] }),
      call(3, 'later', 'write', { file_path: path, content: 'same' }), result(4, 'later', { path, operation, diffs: [] }),
    ], 0))[0]
    assert.deepEqual(planFileRevert(group, 'same'), { action: 'delete', status: 'conflict', reason: 'unproven' })
  }
})

test('replay a native edit from the exact creation text rather than guessing hunk line endings', () => {
  const path = '/w/f.txt'
  const group = groupByPath(collectFileChanges([
    call(1, 'c', 'write', { file_path: path, content: 'one\ntwo\n' }),
    result(2, 'c', { path, operation: 'create', diffs: [] }),
    call(3, 'e', 'edit', { file_path: path, old_string: 'two\n', new_string: 'TWO' }),
    result(4, 'e', { path, diffs: [hunk('one\ntwo', 'one\nTWO')] }),
  ], 0))[0]
  assert.deepEqual(planFileRevert(group, 'one\nTWO'), { action: 'delete', status: 'ok' })
  for (const current of ['one\nTWO\n', 'user\none\nTWO', 'one\r\nTWO']) {
    assert.deepEqual(planFileRevert(group, current), { action: 'delete', status: 'conflict', reason: 'changed' })
  }
})

test('literal creation is byte-strict, including empty content and line endings', () => {
  const path = '/w/f.txt'
  const plan = (content, current) => planFileRevert(groupByPath(collectFileChanges([
    call(1, 'w', 'write', { file_path: path, content }), result(2, 'w', { operation: 'create', path, diffs: [] }),
  ], 0))[0], current)
  assert.deepEqual(plan('', ''), { action: 'delete', status: 'ok' })
  assert.deepEqual(plan('你好\r\n', '你好\r\n'), { action: 'delete', status: 'ok' })
  assert.equal(plan('你好\r\n', '你好\n').reason, 'changed')
  for (const text of ['\ufeffBOM', '\0binary', '\ud800']) assert.equal(plan(text, text).reason, 'unproven')
})

test('malformed metadata is not partially salvaged as proof of a later edit', () => {
  const path = '/w/f.txt'
  const args = { file_path: path, old_string: 'a', new_string: 'b' }
  for (const diffs of [[hunk('a', 'b'), {}], [hunk('a', 'b', '/wrong')], [hunk('not a', 'b')], []]) {
    const group = groupByPath(collectFileChanges([
      call(1, 'w', 'write', { file_path: path, content: 'a' }), result(2, 'w', { operation: 'create', path, diffs: [] }),
      call(3, 'e', 'edit', args), result(4, 'e', { path, diffs }),
    ], 0))[0]
    assert.equal(planFileRevert(group, 'b').reason, 'unproven')
  }
})

test('planFileRevert treats an already absent create as done', () => {
  const group = groupByPath(collectFileChanges([
    call(1, 'w', 'write', { file_path: '/w/x', content: 'x' }),
    result(2, 'w', { operation: 'create', path: '/w/x', diffs: [] }),
  ], 0))[0]
  assert.deepEqual(planFileRevert(group, null), { action: 'already-absent', status: 'ok' })
})

test('presentation hunks cannot prove the original bytes of an existing file', () => {
  const group = {
    createdAfterCut: false,
    changes: [
      { operation: 'edit', diffs: [hunk('one', 'two')] },
      { operation: 'edit', diffs: [hunk('two', 'three')] },
    ],
  }
  assert.deepEqual(planFileRevert(group, 'three'), { action: 'restore', status: 'conflict', reason: 'unproven' })
  assert.deepEqual(planFileRevert(group, 'other'), {
    action: 'restore',
    status: 'conflict',
    reason: 'unproven',
  })
  assert.deepEqual(planFileRevert(group, null), {
    action: 'restore',
    status: 'conflict',
    reason: 'missing',
  })
})

test('a create without exact call content does not authorize deletion', () => {
  const group = { createdAfterCut: true, changes: [{ operation: 'create', diffs: [] }] }
  assert.deepEqual(planFileRevert(group, 'independent work'), { action: 'delete', status: 'conflict', reason: 'unproven' })
})

test('empty update diffs are indistinguishable from an omitted binary before image', () => {
  const group = {
    createdAfterCut: false,
    changes: [{ operation: 'update', diffs: [] }],
  }
  assert.deepEqual(planFileRevert(group, 'same'), { action: 'restore', status: 'conflict', reason: 'unproven' })
})
