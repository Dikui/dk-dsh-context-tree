import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRewindMessage, extractUserText, openTurn, rewindMask, rewindTarget, REWIND_SOURCE_KIND } from '../src/plan.js'

/**
 * Build an ordered session log with contiguous sequence numbers.
 *
 * Mirrors production V4 ordering (verified against stored `session.v4.jsonl.zstd`
 * logs): a turn appends `turn/start` first and admits its prompt's
 * `user/message` *inside* that turn, not before it.
 * @param {Array<[string, unknown]>} entries - Event type and payload pairs.
 * @returns {object[]} Raw session events.
 */
function log(entries) {
  return entries.map((entry, index) => ({ type: entry[0], seq: index, data: entry[1] }))
}

/**
 * One complete turn opened by a durable user message.
 * @param {string} input - Text of the input that starts the turn.
 * @param {string} id - Durable id of that message.
 * @param {string} [output] - Assistant answer.
 * @returns {Array<[string, unknown]>} Turn events.
 */
const turn = (input, id, output = 'answer') => [
  ['turn/start', {}],
  ['user/message', { id, role: 'user', content: [{ type: 'text', text: input }] }],
  ['assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: output }] } }],
  ['turn/end', {}],
]

test('a middle message is addressed by its durable id', () => {
  const events = log([...turn('first', 'm1'), ...turn('second', 'm2'), ...turn('third', 'm3')])
  assert.deepEqual(rewindTarget(events, 'm2'), { kind: 'ok', seq: 5, text: 'second' })
})

test('the newest message keeps its own text, not an earlier one', () => {
  const events = log([...turn('first', 'm1'), ...turn('second', 'm2')])
  assert.deepEqual(rewindTarget(events, 'm2'), { kind: 'ok', seq: 5, text: 'second' })
})

test('the first message is addressable like any other', () => {
  const events = log(turn('only', 'm1'))
  assert.deepEqual(rewindTarget(events, 'm1'), { kind: 'ok', seq: 1, text: 'only' })
})

test('a message added while a turn runs stays addressable', () => {
  const events = log([
    ...turn('first', 'm1'),
    ['turn/start', {}],
    ['user/message', { id: 'm2', role: 'user', content: [{ type: 'text', text: 'second' }] }],
    ['user/message', { id: 's1', role: 'user', content: [{ type: 'text', text: 'steering' }] }],
    ['turn/end', {}],
  ])
  assert.deepEqual(rewindTarget(events, 's1'), { kind: 'ok', seq: 6, text: 'steering' })
})

test('a replacing message is not a rewind target', () => {
  const events = log(turn('first', 'm1'))
  events.push({
    type: 'user/message',
    seq: 4,
    data: { id: 'm9', role: 'user', content: [{ type: 'text', text: 'rewritten' }] },
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
  })
  assert.deepEqual(rewindTarget(events, 'm9'), { kind: 'error', reason: 'unknown-message' })
})

test('unknown messages and empty logs are reported, not guessed', () => {
  const events = log(turn('only', 'm1'))
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

test('the rewind message always carries a non-user source', () => {
  const message = buildRewindMessage('hello', 1700000000000)

  // DSH reads `source.kind` on every durable user message while deriving pending
  // input; a message without a source makes the next prompt throw
  // "Cannot read properties of undefined (reading 'kind')".
  assert.equal(typeof message.source?.kind, 'string')
  assert.equal(message.source.kind, REWIND_SOURCE_KIND)
  assert.notEqual(message.source.kind, 'user')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.match(message.id, /^rewind-[0-9a-z]+$/)
})

test('an open turn is reported and a closed one is not', () => {
  const running = log([['turn/start', { turn: 1 }], ['user/message', { id: 'a' }]])
  assert.equal(openTurn(running), 1)
  const closed = log([['turn/start', { turn: 1 }], ['user/message', { id: 'a' }], ['turn/end', { turn: 1 }]])
  assert.equal(openTurn(closed), undefined)
  const nested = log([
    ['turn/start', { turn: 1 }],
    ['turn/end', { turn: 1 }],
    ['turn/start', { turn: 2 }],
  ])
  assert.equal(openTurn(nested), 2)
})

test('rewindMask reports the turns and messages a marker shadowed', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { id: 'a', source: { kind: 'user' } } },
    { type: 'turn/end', seq: 2, data: { turn: 1 } },
    { type: 'turn/start', seq: 3, data: { turn: 2 } },
    { type: 'user/message', seq: 4, data: { id: 'b', source: { kind: 'user' } } },
    { type: 'turn/end', seq: 5, data: { turn: 2 } },
    {
      type: 'user/message',
      seq: 6,
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 5 },
      data: { id: 'rewind-x', source: { kind: REWIND_SOURCE_KIND } },
    },
    { type: 'turn/start', seq: 7, data: { turn: 3 } },
    { type: 'user/message', seq: 8, data: { id: 'c', source: { kind: 'user' } } },
  ]

  const mask = rewindMask(events)
  assert.equal(mask.cutSeq, 3)
  assert.deepEqual(mask.turns, [2])
  assert.deepEqual(mask.messageIds, ['b'])
})

test('rewindMask keeps a message typed after the rewind visible', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { id: 'a', source: { kind: 'user' } } },
    { type: 'turn/end', seq: 2, data: { turn: 1 } },
    { type: 'turn/start', seq: 3, data: { turn: 2 } },
    { type: 'user/message', seq: 4, data: { id: 'gone', source: { kind: 'user' } } },
    { type: 'turn/end', seq: 5, data: { turn: 2 } },
    {
      type: 'user/message',
      seq: 6,
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 5 },
      data: { id: 'rewind-x', source: { kind: REWIND_SOURCE_KIND } },
    },
    { type: 'turn/start', seq: 7, data: { turn: 3 } },
    { type: 'user/message', seq: 8, data: { id: 'fresh', source: { kind: 'user' } } },
  ]

  const mask = rewindMask(events)
  assert.equal(mask.messageIds.includes('fresh'), false)
  assert.equal(mask.turns.includes(3), false)
})

test('rewindMask is empty for a log without a marker', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { id: 'a', source: { kind: 'user' } } },
    { type: 'turn/end', seq: 2, data: { turn: 1 } },
  ]

  assert.deepEqual(rewindMask(events), { cutSeq: -1, turns: [], messageIds: [] })
})

test('rewindMask ignores a native system replacement', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'system/message', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'a', source: { kind: 'user' } } },
    // DSH replaces its per-step system message between steps, inside the same
    // turn. There is no user rewind here; masking its turn would hide the whole
    // answer even though this session was never rewound.
    {
      type: 'system/message',
      seq: 3,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      data: { turn: 1 },
    },
  ]

  assert.deepEqual(rewindMask(events), { cutSeq: -1, turns: [], messageIds: [] })
})

test('rewindMask ignores compaction, tool-result and native user replacements', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { id: 'a', source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { turn: 1 } },
    { type: 'tool/result', seq: 3, data: { turn: 1 } },
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
    { type: 'turn/start', seq: 5, data: { turn: 2 } },
    { type: 'user/message', seq: 6, data: { id: 'b', source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 7, data: { turn: 2 } },
    { type: 'turn/end', seq: 8, data: { turn: 2 } },
    // Compaction replaces the whole prefix and re-sends selected tool results.
    {
      type: 'user/message',
      seq: 9,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 8 },
      data: { id: 'compact', source: { kind: 'compact-checkpoint' } },
    },
    {
      type: 'tool/result',
      seq: 10,
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
      data: { turn: 1 },
    },
    // Some native messages are replaced without any source kind at all.
    {
      type: 'user/message',
      seq: 11,
      surfaceOp: { op: 'replace', startSeq: 6, endSeq: 6 },
      data: { id: 'native-user' },
    },
  ]

  assert.deepEqual(rewindMask(events), { cutSeq: -1, turns: [], messageIds: [] })
})

test('rewindMask folds this plugin marker but not a native replacement', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { id: 'a', source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { turn: 1 } },
    {
      type: 'system/message',
      seq: 3,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      data: { turn: 1 },
    },
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
    { type: 'turn/start', seq: 5, data: { turn: 2 } },
    { type: 'user/message', seq: 6, data: { id: 'b', source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 7, data: { turn: 2 } },
    { type: 'turn/end', seq: 8, data: { turn: 2 } },
    {
      type: 'user/message',
      seq: 9,
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 8 },
      data: { id: 'rewind-x', source: { kind: REWIND_SOURCE_KIND } },
    },
    { type: 'turn/start', seq: 10, data: { turn: 3 } },
    { type: 'user/message', seq: 11, data: { id: 'fresh', source: { kind: 'user' } } },
  ]

  assert.deepEqual(rewindMask(events), { cutSeq: 5, turns: [2], messageIds: ['b'] })
})
