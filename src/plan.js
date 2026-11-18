/**
 * Pure history analysis behind the per-message "rewind to here" action.
 *
 * Inputs are the raw `SessionEvent[]` from `ctx.sessionQuery.readSession(id)`
 * and, for planRewind, the live ordered surface node ids. No store or Client
 * services are needed here.
 *
 * @module dk-dsh-context-tree/plan
 */

/**
 * Whether an event appends to the surface instead of replacing a range.
 * @param {{ surfaceOp?: unknown }} event - Raw session event envelope.
 * @returns {boolean} True unless the event is an explicit replacement.
 */
function isAppend(event) {
  return event.surfaceOp === undefined || event.surfaceOp === 'append'
}

/**
 * Extract the plain text of a durable user message.
 * @param {{ data?: { content?: unknown } } | undefined} event - `user/message` event, if any.
 * @returns {string} Text parts joined by blank lines; non-text parts are dropped.
 */
export function extractUserText(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    }
  }
  return parts.join('\n\n')
}

/**
 * Locate the durable user message a rewind starts from.
 *
 * The message is addressed by its durable `data.id`, not by a rendered
 * position, so the lookup survives refreshes and never guesses an offset.
 *
 * @param {readonly { type: string, seq: number, surfaceOp?: unknown, data?: unknown }[]} events - Complete raw log.
 * @param {string} messageId - Durable id of the chosen user message.
 * @returns {{ kind: 'ok', seq: number, text: string } | { kind: 'error', reason: string }} Target or a stable reason.
 */
export function rewindTarget(events, messageId) {
  if (!Array.isArray(events) || events.length === 0) return { kind: 'error', reason: 'empty-log' }
  if (typeof messageId !== 'string' || messageId.length === 0) return { kind: 'error', reason: 'unknown-message' }

  const index = events.findIndex(event => event !== null && typeof event === 'object'
    && event.type === 'user/message'
    && typeof event.data === 'object' && event.data !== null
    && String(event.data.id) === messageId)
  if (index < 0) return { kind: 'error', reason: 'unknown-message' }

  const target = events[index]
  if (!isAppend(target)) return { kind: 'error', reason: 'unknown-message' }
  const seq = typeof target.seq === 'number' ? target.seq : index
  return { kind: 'ok', seq, text: extractUserText(target) }
}

/**
 * Whether the log ends inside a turn the agent is still running.
 *
 * A replacement appended while a turn is open is not equivalent to one appended
 * between turns: the running request already holds the old context, and the
 * turn's own events keep arriving after a surface they no longer match. The
 * route therefore refuses to rewind a busy session instead of racing it.
 *
 * @param {readonly { type: string, data?: { turn?: unknown } }[]} events - Complete raw log.
 * @returns {number | undefined} Number of the open turn, when there is one.
 */
export function openTurn(events) {
  let open
  for (const event of events) {
    if (event.type === 'turn/start') open = typeof event.data?.turn === 'number' ? event.data.turn : -1
    else if (event.type === 'turn/end') open = undefined
  }
  return open
}

/** Stable producer identity for all generations of this plugin's rewind markers. */
export const REWIND_SOURCE_KIND = 'context-tree-rewind'
const CHAT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const SURFACE_TYPES = new Set([...CHAT_TYPES, 'system/message', 'developer/message'])

/**
 * Replace the selected surface suffix with a fixed notice, not the draft.
 * V4 permits a producer-attributed user replacement between turns; a developer
 * event there fails cold restore even if it cites an earlier real step.
 * This is a log operation, not inbox delivery: it does not start a new turn.
 * @param {readonly object[]} events - Raw V4 log used to resolve the target.
 * @param {readonly number[]} nodes - Current surface in model-visible order.
 * @param {number} startSeq - Sequence of the selected append-origin prompt.
 */
export function planRewind(events, nodes, startSeq) {
  const index = nodes.indexOf(startSeq)
  if (index < 0) return { kind: 'error', reason: 'not-surface-node' }
  let turn, position, target
  let hasEarlierRow = false
  for (const event of events) {
    if (event.seq === startSeq) { target = event; break }
    if (event.type === 'turn/start') {
      turn = event.data?.turn
      position = undefined
      hasEarlierRow = false
    } else if (event.type === 'turn/end') {
      turn = position = undefined
    } else if (event.type === 'step/start') position = event.data
    else if (event.type === 'step/end') position = undefined
    if (isAppend(event) && CHAT_TYPES.has(event.type)) hasEarlierRow = true
  }
  if (target?.type !== 'user/message' || !isAppend(target)) return { kind: 'error', reason: 'unknown-message' }
  if (!Number.isSafeInteger(turn) || turn < 1 || position?.turn !== turn
    || !Number.isSafeInteger(position.step) || position.step < 1) {
    return { kind: 'error', reason: 'missing-step-position' }
  }
  // Chat's existing mask can hide complete turns, not the trailing steps of
  // one turn. Fail closed instead of hiding a prefix the model will still see.
  if (hasEarlierRow) return { kind: 'error', reason: 'partial-turn' }
  const sourceEventSeqs = nodes.slice(index)
  return {
    kind: 'ok',
    type: 'user/message',
    data: {
      id: `rewind-${startSeq}`, role: 'user', source: { kind: REWIND_SOURCE_KIND },
      content: [{ type: 'text', text: 'Conversation rewound.' }],
    },
    options: { surfaceOp: { op: 'replace', startSeq, endSeq: sourceEventSeqs.at(-1) }, sourceEventSeqs },
  }
}

/**
 * Which turns and messages this plugin's own rewinds no longer expose.
 *
 * The Chat paints one row per appended event and never removes a row, so a
 * `replace` changes what the model reads while the screen keeps the old
 * transcript. The Client needs to know exactly which rows are gone — not "every
 * row from here down", because the user usually types a new message right after
 * a rewind and that message must stay visible.
 *
 * Only markers written by this plugin count. DSH also appends `replace` events
 * for other reasons — a `system/message` is replaced between steps, compaction
 * emits a `compact-checkpoint` plus replayed `tool/result` events — and those
 * carry extra provenance that need not lie in the replaced range. Replay
 * positional splices to recover the exact nodes each replacement covered.
 * Start the ancestry walk only at our markers; native replacements then lead
 * to original Chat rows only when a rewind eventually shadows those nodes.
 *
 * @param {readonly { type: string, seq: number, surfaceOp?: unknown, data?: unknown }[]} events - Complete raw log.
 * @returns {{ cutSeq: number, turns: number[], messageIds: string[], retainedRowKeys?: string[] }} Shadowed coverage and any context cards retained within those turns.
 */
export function rewindMask(events) {
  const nodes = []
  const children = new Map()
  const markers = new Set()
  const work = []
  if (!Array.isArray(events)) return { cutSeq: -1, turns: [], messageIds: [] }
  for (const event of events) {
    if (!SURFACE_TYPES.has(event?.type)) continue
    if (isAppend(event)) { nodes.push(event.seq); continue }
    const op = event.surfaceOp
    if (op?.op !== 'replace') continue
    const start = nodes.indexOf(op.startSeq)
    const end = nodes.indexOf(op.endSeq)
    if (start < 0 || end < start) continue
    const removed = nodes.splice(start, end - start + 1, event.seq)
    children.set(event.seq, removed)
    const message = event.type === 'user/message' ? event.data : event.data?.message
    const userMarker = event.type === 'user/message' && message?.role === 'user'
    const legacyDeveloper = event.type === 'developer/message' && message?.role === 'developer'
      && Array.isArray(message.content) && message.content.length === 0
    if ((userMarker || legacyDeveloper) && message.source?.kind === REWIND_SOURCE_KIND) {
      const sources = event.sourceEventSeqs
      // DSH permits extra citations. A legacy numeric-range producer could
      // legally cite a replaced system head that actually survived this cut.
      if (!Array.isArray(sources)) continue
      const ids = new Set(sources)
      if (ids.size !== sources.length || !removed.every(seq => ids.has(seq))) continue
      markers.add(event.seq)
      for (const seq of removed) work.push(seq)
    }
  }

  const hidden = new Set()
  while (work.length) {
    const seq = work.pop()
    if (hidden.has(seq)) continue
    hidden.add(seq)
    for (const child of children.get(seq) || []) work.push(child)
  }
  const turns = new Set()
  const retainedTurns = new Set()
  const messageIds = new Set()
  const contextCards = []
  let cutSeq = -1
  let open
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data?.turn
    if (event.type === 'turn/end') open = undefined
    if (markers.has(event.seq) && event.type === 'user/message') messageIds.add(event.data.id)
    if (!isAppend(event)) continue
    const turn = event.data?.turn ?? open
    // Chat keys system cards by seq and developer cards by durable message id.
    // A whole-turn mask still needs to leave the retained context prefix visible.
    if (!hidden.has(event.seq)) {
      if (event.type === 'system/message') contextCards.push([turn, `14:system-message${event.seq}`])
      if (event.type === 'developer/message' && typeof event.data?.message?.id === 'string') {
        contextCards.push([turn, `17:developer-message${event.data.message.id}`])
      }
    }
    if (!CHAT_TYPES.has(event.type)) continue
    if (hidden.has(event.seq)) {
      if (cutSeq < 0) cutSeq = event.seq
      if (Number.isSafeInteger(turn)) turns.add(turn)
      if (event.type === 'user/message' && typeof event.data?.id === 'string') messageIds.add(event.data.id)
    } else if (Number.isSafeInteger(turn)) retainedTurns.add(turn)
  }
  for (const turn of retainedTurns) turns.delete(turn)
  const retainedRowKeys = contextCards.filter(([turn]) => turns.has(turn)).map(([, key]) => key)
  return {
    cutSeq,
    turns: [...turns].sort((a, b) => a - b),
    messageIds: [...messageIds],
    ...(retainedRowKeys.length ? { retainedRowKeys } : {}),
  }
}
