import test from 'node:test'
import assert from 'node:assert/strict'

import { extractUserText, openTurn, planRewind, rewindMask, rewindTarget, REWIND_SOURCE_KIND } from '../src/plan.js'

/**
 * Build an ordered session log with contiguous sequence numbers.
 *
 * Mirrors production V4 ordering (verified against stored `session.v4.jsonl.zstd`
 * logs): a turn appends `turn/start` first and admits its prompt's
 * `user/message` *inside* that turn, not before it.
 * @param {Array<[string, object, object?]>} entries - Type, payload and optional surface intent.
 * @returns {object[]} Raw session events.
 */
function log(entries) {
  const surface = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
  const nodes = []
  return entries.map(([type, data, options], seq) => {
    const event = { type, seq, data, time: seq, ...(surface.has(type) ? { surfaceOp: 'append' } : {}), ...options }
    if (event.surfaceOp === 'append') nodes.push(seq)
    else if (event.surfaceOp?.op === 'replace') {
      const start = nodes.indexOf(event.surfaceOp.startSeq), end = nodes.indexOf(event.surfaceOp.endSeq)
      assert.ok(start >= 0 && end >= start, `fixture at ${seq} must replace live surface nodes`)
      for (const source of nodes.splice(start, end - start + 1, seq)) assert.ok(event.sourceEventSeqs.includes(source))
    }
    return event
  })
}

const user = (id, text = id, kind = 'user') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] })
const start = turn => [['turn/start', { turn }], ['step/start', { turn, step: 1 }]]
const end = turn => [['step/end', { turn, step: 1 }], ['turn/end', { turn, reason: { kind: 'completed' } }]]
const replace = (first, last, ...sources) => ({ surfaceOp: { op: 'replace', startSeq: first, endSeq: last }, sourceEventSeqs: sources })
const answer = turn => ['assistant/message', { turn, step: 1, stream: [], message: {
  id: `a${turn}`, role: 'assistant', source: { kind: 'model', model: 'stub', provider: 'stub' }, content: [{ type: 'text', text: 'answer' }],
} }]
const turn = (n, input, id) => [...start(n), ['user/message', user(id, input)], answer(n), ...end(n)]

test('a middle message is addressed by its durable id', () => {
  const events = log([...turn(1, 'first', 'm1'), ...turn(2, 'second', 'm2'), ...turn(3, 'third', 'm3')])
  assert.deepEqual(rewindTarget(events, 'm2'), { kind: 'ok', seq: 8, text: 'second' })
})

test('the newest message keeps its own text, not an earlier one', () => {
  const events = log([...turn(1, 'first', 'm1'), ...turn(2, 'second', 'm2')])
  assert.deepEqual(rewindTarget(events, 'm2'), { kind: 'ok', seq: 8, text: 'second' })
})

test('the first message is addressable like any other', () => {
  const events = log(turn(1, 'only', 'm1'))
  assert.deepEqual(rewindTarget(events, 'm1'), { kind: 'ok', seq: 2, text: 'only' })
})

test('a message added while a turn runs stays addressable', () => {
  const events = log([
    ...turn(1, 'first', 'm1'), ...start(2),
    ['user/message', user('m2', 'second')], ['user/message', user('s1', 'steering')], ...end(2),
  ])
  assert.deepEqual(rewindTarget(events, 's1'), { kind: 'ok', seq: 9, text: 'steering' })
})

test('a replacing message is not a rewind target', () => {
  const events = log([...turn(1, 'first', 'm1'), ['user/message', user('m9', 'rewritten'), replace(2, 2, 2)]])
  assert.deepEqual(rewindTarget(events, 'm9'), { kind: 'error', reason: 'unknown-message' })
})

test('unknown messages and empty logs are reported, not guessed', () => {
  const events = log(turn(1, 'only', 'm1'))
  assert.deepEqual(rewindTarget(events, 'nope'), { kind: 'error', reason: 'unknown-message' })
  assert.deepEqual(rewindTarget(events, ''), { kind: 'error', reason: 'unknown-message' })
  assert.deepEqual(rewindTarget(events, undefined), { kind: 'error', reason: 'unknown-message' })
  assert.deepEqual(rewindTarget([], 'm1'), { kind: 'error', reason: 'empty-log' })
})

test('text extraction joins text parts and drops the others', () => {
  const event = {
    data: {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', mediaType: 'image/png', data: 'AA==' },
        { type: 'text', text: 'world' },
      ],
    },
  }
  assert.equal(extractUserText(event), 'hello\n\nworld')
  assert.equal(extractUserText({ data: { content: [] } }), '')
  assert.equal(extractUserText(undefined), '')
})

// Regression: a step's numeric fields alone do not prove the target's turn.
test('rewind requires a positive step belonging to the open turn', () => {
  for (const [turn, stepTurn, step] of [[undefined, 2, 1], [2, 3, 1], [0, 0, 1], [1, 1, 0]]) {
    const events = log([
      ...(turn === undefined ? [] : [['turn/start', { turn }]]),
      ['step/start', { turn: stepTurn, step }],
      ['user/message', { id: 'target', role: 'user' }],
    ])
    const seq = events.at(-1).seq
    assert.deepEqual(planRewind(events, [seq], seq), { kind: 'error', reason: 'missing-step-position' })
  }
})

test('a mid-turn steering cut is refused rather than masking the earlier prompt and answer', () => {
  const events = log([
    ['turn/start', { turn: 1 }], ['step/start', { turn: 1, step: 1 }],
    ['user/message', { id: 'prompt', source: { kind: 'user' } }],
    ['assistant/message', { turn: 1, step: 1 }], ['step/end', { turn: 1, step: 1 }],
    ['step/start', { turn: 1, step: 2 }], ['user/message', { id: 'steer', source: { kind: 'user' } }],
    ['step/end', { turn: 1, step: 2 }], ['turn/end', { turn: 1 }],
  ])
  assert.deepEqual(planRewind(events, [2, 3, 6], 6), { kind: 'error', reason: 'partial-turn' })
})

test('rewinding the opening prompt retains earlier context cards but not context appended after it', () => {
  const pos = { turn: 1, step: 1 }
  const context = (role, id) => ({ ...pos, message: { role, id, content: [{ type: 'text', text: id }] } })
  const events = log([
    ['turn/start', { turn: 1 }], ['step/start', pos],
    ['system/message', context('system', 'sys')], ['developer/message', context('developer', 'before')],
    ['user/message', { id: 'a', role: 'user' }], ['developer/message', context('developer', 'after')],
    ['step/end', pos], ['turn/end', { turn: 1 }],
  ])
  const marker = planRewind(events, [2, 3, 4, 5], 4)
  assert.equal(marker.kind, 'ok')
  const mask = rewindMask([...events, { type: marker.type, seq: 8, data: marker.data, ...marker.options }])
  assert.deepEqual(mask.turns, [1])
  assert.deepEqual(mask.retainedRowKeys, ['14:system-message2', '17:developer-messagebefore'])
})

test('an open turn is reported and a closed one is not', () => {
  const running = log([...start(1), ['user/message', user('a')]])
  assert.equal(openTurn(running), 1)
  const closed = log(turn(1, 'only', 'a'))
  assert.equal(openTurn(closed), undefined)
  const nested = log([
    ['turn/start', { turn: 1 }],
    ['turn/end', { turn: 1 }],
    ['turn/start', { turn: 2 }],
  ])
  assert.equal(openTurn(nested), 2)
})

const twoTurns = () => [...turn(1, 'first', 'a'), ...turn(2, 'second', 'b')]
const legacyCut = () => ['user/message', user('rewind-x', 'second', REWIND_SOURCE_KIND), replace(8, 9, 8, 9)]

test('rewindMask reports the turns and messages a marker shadowed', () => {
  const mask = rewindMask(log([...twoTurns(), legacyCut()]))
  assert.equal(mask.cutSeq, 8)
  assert.deepEqual(mask.turns, [2])
  assert.deepEqual(mask.messageIds, ['b', 'rewind-x'])
})

test('rewindMask keeps a message typed after the rewind visible', () => {
  const mask = rewindMask(log([...twoTurns(), legacyCut(), ...turn(3, 'fresh', 'fresh')]))
  assert.equal(mask.messageIds.includes('fresh'), false)
  assert.equal(mask.turns.includes(3), false)
})

test('rewindMask is empty for a log without a marker', () => {
  const events = log(turn(1, 'first', 'a'))

  assert.deepEqual(rewindMask(events), { cutSeq: -1, turns: [], messageIds: [] })
})

test('rewindMask ignores a native system replacement', () => {
  const system = step => ({ turn: 1, step, message: {
    id: `sys-${step}`, role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'system' }],
  } })
  const events = log([...start(1), ['system/message', system(1)], ['user/message', user('a')],
    ['step/end', { turn: 1, step: 1 }], ['step/start', { turn: 1, step: 2 }],
    ['system/message', system(2), replace(2, 2, 2)],
  ])

  assert.deepEqual(rewindMask(events), { cutSeq: -1, turns: [], messageIds: [] })
})

test('rewindMask ignores compaction, tool-result and native user replacements', () => {
  const pos = { turn: 1, step: 1 }
  const tool = text => ({ ...pos, message: { id: 'tool-r', role: 'tool', source: { kind: 'tool', callId: 'c' },
    toolCallId: 'c', content: [{ type: 'text', text }], isError: false } })
  const events = log([...start(1), ['user/message', user('a')], answer(1),
    ['tool/call', { ...pos, name: 'read', callId: 'c', arguments: '{}' }],
    ['tool/result', tool('original'), { sourceEventSeqs: [4] }], ...end(1), ...turn(2, 'second', 'b'),
    ['tool/result', tool('abridged'), replace(5, 5, 5)],
    ['user/message', user('native-user'), replace(10, 10, 10)],
    // Only current surface nodes [2, 3, 14] belong to this prefix.
    ['user/message', user('compact', 'summary', 'compact-checkpoint'), replace(2, 14, 2, 3, 14)],
  ])

  assert.deepEqual(rewindMask(events), { cutSeq: -1, turns: [], messageIds: [] })
})

test('rewindMask folds this plugin marker but not a native replacement', () => {
  const events = log([...twoTurns(),
    ['user/message', user('native', 'summary', 'compact-checkpoint'), replace(2, 3, 2, 3)],
    legacyCut(), ...turn(3, 'fresh', 'fresh'),
  ])
  assert.deepEqual(rewindMask(events), { cutSeq: 8, turns: [2], messageIds: ['b', 'rewind-x'] })
})
