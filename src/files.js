/**
 * Read-only analysis of logged file changes. RC3 tool metadata is for display,
 * not an inverse patch: it drops EOF markers, normalizes line ends and may omit
 * the preimage entirely. Never derive bytes to write from these hunks.
 */

import { isDeepStrictEqual } from 'node:util'

function parseArguments(value) {
  if (typeof value !== 'string') return undefined
  try {
    const args = JSON.parse(value)
    return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : undefined
  } catch {
    return undefined
  }
}

const observations = new Set(['read', 'read_image', 'glob', 'grep'])
const nativeMutation = name => name === 'write' || name === 'edit'
const validPath = path => typeof path === 'string' && path.length > 0
const validHunk = (diff, path) => diff?.path === path
  && (diff.oldText === null || typeof diff.oldText === 'string') && typeof diff.newText === 'string'

/** Return the actual native call cited by this result, never a callId search. */
function sourceCall(event, calls) {
  const sources = event.sourceEventSeqs
  const call = Array.isArray(sources) && sources.length === 1 ? calls.get(sources[0]) : undefined
  const msg = event.data?.message
  if (!call || event.surfaceOp !== 'append' || call.seq >= event.seq || msg?.role !== 'tool'
    || typeof call.data.callId !== 'string' || !call.data.callId || msg.toolCallId !== call.data.callId
    || msg.source?.kind !== 'tool' || msg.source.callId !== call.data.callId
    || !Number.isInteger(call.data.turn) || !Number.isInteger(call.data.step)
    || call.data.turn !== event.data.turn || call.data.step !== event.data.step) return undefined
  return call
}

/**
 * Translate the live suffix into original append ids. readSession replay has
 * already validated membership of each replace range in the then-live surface.
 * Follow only its single positional tool/result predecessor, never extra cited
 * sources or ancestry behind compaction/rewind. Preserve operation-time order.
 */
function selectedAppends(events, suffix) {
  const wanted = new Set(suffix)
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const withoutContent = data => ({ ...data, message: { ...data.message, content: null } })
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'tool/result' || !wanted.has(event.seq) || event.surfaceOp === 'append') continue
    wanted.delete(event.seq)
    const op = event.surfaceOp
    if (op?.op !== 'replace' || op.startSeq !== op.endSeq || op.startSeq >= event.seq) continue
    const prev = bySeq.get(op.startSeq)
    if (prev?.type === 'tool/result' && prev.data?.message && event.data?.message
      && event.sourceEventSeqs?.includes(prev.seq)
      && isDeepStrictEqual(withoutContent(prev.data), withoutContent(event.data))) wanted.add(prev.seq)
  }
  return wanted
}

/**
 * Collect native root file changes from the selected live suffix.
 * An intervening same-path result cannot be forgotten by filtering out its seq;
 * an opaque tool may have modified *any* path. Barriers veto earlier creations
 * but are not themselves offered as reversible changes.
 */
export function collectFileChanges(events, startSeq, selected, inheritedEventCount = 0) {
  if (!Array.isArray(events) || !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) return []
  // Surface selection omits raw records such as nested dispatches. Use its
  // earliest selected seq as the time boundary, never a membership test here.
  let boundary = startSeq + 1
  if (selected) {
    boundary = Infinity
    for (const seq of selected) if (seq < boundary) boundary = seq
  }
  const touched = new Set()
  const calls = new Map()
  const pending = new Set()
  const last = new Map()
  const changes = []
  let opaqueSeq = -1
  function barrier(path, seq) {
    if (!validPath(path)) opaqueSeq = Math.max(opaqueSeq, seq)
    else {
      if (seq >= boundary) touched.add(path)
      if (last.has(path)) last.get(path).nextSeq ??= seq
    }
  }
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq)) continue
    const { type, seq, data } = event
    if (type === 'tool/call' && data) {
      calls.set(seq, event)
      if (!observations.has(data.name)) pending.add(seq)
      continue
    }
    if (type === 'tool/ptc-dispatch') {
      if (!observations.has(data?.name)) barrier(nativeMutation(data?.name) ? data?.meta?.path : undefined, seq)
      continue
    }
    if (type !== 'tool/result' || (event.surfaceOp !== undefined && event.surfaceOp !== 'append')) continue
    const call = sourceCall(event, calls)
    if (call) pending.delete(call.seq)
    if (seq <= startSeq) continue
    const name = call?.data.name
    const meta = data?.meta
    const path = meta?.path
    const hasDiffs = Array.isArray(meta?.diffs)
    if (observations.has(name) && !hasDiffs) continue
    // Failed mutations may already have had side effects. Unrecognized tools
    // (shell, apply_patch, third parties, etc.) have no complete path ledger.
    if (!nativeMutation(name)) {
      barrier(undefined, seq)
      continue
    }
    if (data?.error || data?.message?.isError === true || !validPath(path)) {
      barrier(path, seq)
      continue
    }
    const op = meta.operation
    const operation = op === 'create' || op === 'update' ? op : 'edit'
    const diffs = hasDiffs ? meta.diffs.filter(diff => validHunk(diff, path)) : []
    const valid = hasDiffs && diffs.length === meta.diffs.length && (name === 'write'
      ? op === 'update' || (op === 'create' && !diffs.length) : name === 'edit' && op === undefined)
    const earlierMutation = opaqueSeq >= boundary || touched.has(path)
    barrier(path, seq)
    const args = valid ? parseArguments(call.data.arguments) : undefined
    const change = { path, seq, callSeq: call?.seq, callId: call?.data.callId, tool: name,
      operation, args: validPath(args?.file_path) ? args : undefined, diffs }
    // Creation proves absence only at the write, not before an intervening
    // deletion or earlier history of the same path in the selected interval.
    if (operation === 'create' && earlierMutation) change.unproven = true
    changes.push(change)
    last.set(path, change)
  }
  // A missing terminal result cannot prove that the operation had no effect.
  for (const change of changes) {
    if (pending.size || opaqueSeq > change.seq) change.unproven = true
  }
  if (!changes.length) return []
  const wanted = selected && selectedAppends(events, selected)
  // Original append evidence must belong to this session and interval on both
  // ends. A later rewrite, or a child result for a parent's call, confers no
  // ownership. Keep all events above in the ledger so discarded rows still veto.
  const firstOwn = Math.max(boundary, inheritedEventCount)
  return changes.filter(change => change.callSeq >= firstOwn && (!wanted || wanted.has(change.seq)))
}

/** Group the selected changes by canonical result path, in first-seen order. */
export function groupByPath(changes) {
  const groups = new Map()
  for (const change of changes) {
    let group = groups.get(change.path)
    if (!group) {
      group = { path: change.path, createdAfterCut: change.operation === 'create', changes: [] }
      groups.set(change.path, group)
    }
    group.changes.push(change)
  }
  return [...groups.values()]
}

/** Replay only the small, unambiguous native literal edit we can model exactly. */
function replayEdit(before, change) {
  if (change.tool !== 'edit' || change.operation !== 'edit' || change.diffs.length !== 1) return undefined
  const { old_string: oldText, new_string: newText, replace_all: all } = change.args ?? {}
  if ((all !== undefined && all !== false) || typeof oldText !== 'string' || !oldText || typeof newText !== 'string') return undefined
  // RC3 normalizes line endings for edits. Decline CR/mixed input rather than
  // duplicating backend-specific normalization and restoration here.
  if ([before, oldText, newText].some(text => text.includes('\r') || text.includes('\0') || text.startsWith('\uFEFF'))) return undefined
  const start = before.indexOf(oldText)
  if (start < 0 || before.indexOf(oldText, start + 1) !== -1) return undefined
  const after = before.slice(0, start) + newText + before.slice(start + oldText.length)
  // Independent corroboration: require the entire small-file before/after to
  // match the single displayed hunk, with only its documented EOF loss.
  const display = text => text.endsWith('\n') ? text.slice(0, -1) : text
  const [diff] = change.diffs
  if (diff.oldText !== display(before) || diff.newText !== display(after)) return undefined
  return after
}

/**
 * Plan one path. A successful creation proves absence at the time it ran. The
 * only actionable result is deletion of a file matching its complete logged
 * creation + fully witnessed edits, not merely a matching substring. Host must
 * ensure that current is losslessly decoded, and bind its version to deletion.
 */
export function planFileRevert(group, current) {
  if (!group.createdAfterCut) {
    return { action: 'restore', status: 'conflict', reason: current === null ? 'missing' : 'unproven' }
  }
  const changes = group.changes
  const first = changes[0]
  const unproven = { action: 'delete', status: 'conflict', reason: 'unproven' }
  let expected = first?.args?.content
  if (first?.tool !== 'write' || first.operation !== 'create' || first.diffs.length !== 0
    || typeof expected !== 'string' || expected.includes('\0') || expected.startsWith('\uFEFF') || !expected.isWellFormed()) return unproven
  for (const [i, change] of changes.entries()) {
    const next = changes[i + 1]
    if (change.unproven || change.nextSeq !== next?.seq || (next && next.callSeq <= change.seq)) return unproven
    if (i > 0) {
      expected = replayEdit(expected, change)
      if (expected === undefined) return unproven
    }
  }
  if (current === null) return { action: 'already-absent', status: 'ok' }
  if (current !== expected) return { action: 'delete', status: 'conflict', reason: 'changed' }
  return { action: 'delete', status: 'ok' }
}
