/**
 * Pure history analysis behind the per-message "rewind to here" action.
 *
 * Everything here works on raw `SessionEvent[]` as returned by
 * `ctx.sessionQuery.readSession(id)`, so it stays independent of the Session
 * Store, of projection state, and of the Client.
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

/** Source kind stamped on the message this plugin appends to carry a rewind. */
export const REWIND_SOURCE_KIND = 'context-tree-rewind'

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
 * carry the affected `data.turn` without any user rewind. Folding them would
 * hide a whole turn the user never cut, in a session that was only compacted or
 * retried. A marker is a `user/message` whose source kind is
 * `context-tree-rewind`; the events it covers are then folded in log order.
 *
 * @param {readonly { type: string, seq: number, surfaceOp?: unknown, data?: unknown }[]} events - Complete raw log.
 * @returns {{ cutSeq: number, turns: number[], messageIds: string[] }} Shadowed coverage.
 */
export function rewindMask(events) {
  const shadowed = new Set()
  if (!Array.isArray(events)) return { cutSeq: -1, turns: [], messageIds: [] }

  for (const event of events) {
    if (event?.type !== 'user/message' || event?.data?.source?.kind !== REWIND_SOURCE_KIND) continue
    const op = event.surfaceOp
    if (op?.op !== 'replace') continue
    const start = op.startSeq
    const end = op.endSeq
    if (typeof start !== 'number' || typeof end !== 'number' || end < start) continue
    for (let seq = start; seq <= end; seq += 1) shadowed.add(seq)
  }
  if (shadowed.size === 0) return { cutSeq: -1, turns: [], messageIds: [] }

  const turns = new Set()
  const messageIds = new Set()
  let cutSeq = -1
  for (const event of events) {
    if (typeof event?.seq !== 'number' || !shadowed.has(event.seq)) continue
    if (cutSeq < 0 || event.seq < cutSeq) cutSeq = event.seq
    const turn = event.data?.turn
    if (typeof turn === 'number') turns.add(turn)
    if (event.type === 'user/message' && typeof event.data?.id === 'string') messageIds.add(event.data.id)
  }
  return {
    cutSeq,
    turns: [...turns].sort((a, b) => a - b),
    messageIds: [...messageIds],
  }
}

/**
 * Build the `user/message` payload that shadows a surface suffix.
 *
 * The payload must carry a `source`. DSH derives pending input from durable
 * `user/message` events and reads `source.kind` on every candidate, so a message
 * without one makes the *next* prompt fail with
 * `Cannot read properties of undefined (reading 'kind')` — a failure that only
 * shows up after the rewind, far from its cause. The custom kind also keeps this
 * event out of the "pending user input" set, which a `user` source would join,
 * so the Host never answers the rewind message on its own.
 *
 * @param {string} text - Text of the message the user is rewinding to.
 * @param {number} [now] - Millisecond timestamp used for the durable id.
 * @returns {{ id: string, role: 'user', content: { type: 'text', text: string }[], source: { kind: string } }} Message payload.
 */
export function buildRewindMessage(text, now = Date.now()) {
  return {
    id: `rewind-${now.toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: REWIND_SOURCE_KIND },
  }
}
