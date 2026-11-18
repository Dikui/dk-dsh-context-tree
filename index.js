/**
 * Host half of dk-dsh-context-tree.
 *
 * Three same-origin routes over Host services:
 * - `truncate` performs an in-place rewind: it appends a model-invisible marker that
 *   carries a `surfaceOp: replace` over the live surface suffix, so the model
 *   stops seeing that suffix without any new session being created. When asked,
 *   it then applies only file actions supported by exact evidence.
 * - `preview` reports the same rewind without changing anything: which files
 *   the suffix wrote or edited, what the current bytes allow, and the recorded
 *   hunks for display.
 * - `cut` reports where earlier rewinds already cut a session, so the Client can
 *   rebuild its view after a reload instead of trusting page memory.
 *
 * None of these routes rewrites stored events; DSH logs are append-only and a
 * replacement only shadows the surface.
 *
 * @module dk-dsh-context-tree
 */

import { createHmac, randomBytes } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'

import { collectFileChanges, groupByPath, planFileRevert } from './src/files.js'
import { openTurn, planRewind, rewindMask, rewindTarget } from './src/plan.js'

/** Same-origin JSON route that performs an in-place rewind. */
export const TRUNCATE_ROUTE = '/api/dk-dsh-context-tree/truncate'

/** Same-origin JSON route reporting where an earlier rewind already cut. */
export const CUT_ROUTE = '/api/dk-dsh-context-tree/cut'

/** Same-origin JSON route that previews the file changes a rewind would revert. */
export const PREVIEW_ROUTE = '/api/dk-dsh-context-tree/preview'

/** Largest request body accepted; every payload here is a pair of scalars. */
const MAX_BODY_BYTES = 4096

/** Files above this size are reported but never read into the Host. */
const REVERT_MAX_BYTES = 2 * 1024 * 1024

/** Recorded hunks above this size are omitted from the preview payload. */
const DIFF_MAX_CHARS = 64 * 1024

/** Host services this plugin uses. */
export const inject = ['connection', 'fs', 'sandboxPolicy', 'sessionQuery', 'sessions']

/**
 * Register all three routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {void}
 */
export function apply(ctx) {
  const previewKey = randomBytes(32)
  ctx.effect(() => ctx.connection.fetch.register({
    path: TRUNCATE_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleRewind(ctx, request, previewKey, true),
  }), 'dk-dsh-context-tree: truncate route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: CUT_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleCut(ctx, request),
  }), 'dk-dsh-context-tree: cut route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: PREVIEW_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleRewind(ctx, request, previewKey, false),
  }), 'dk-dsh-context-tree: preview route')
}

/**
 * Both routes use the same planner. A stateless token binds the confirmation to
 * the log revision and suffix. The second tag also binds the observed file plan:
 * changes on disk need not prevent a conversation-only rewind.
 */
async function handleRewind(ctx, request, key, confirm) {
  const parsed = await readTarget(request)
  if (parsed.response) return parsed.response
  const { sessionId, messageId, revertFiles, previewToken } = parsed
  const stale = () => json({ ok: false, reason: 'preview-stale' }, 409)
  if (confirm && (typeof previewToken !== 'string' || !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(previewToken))) return stale()
  const session = ctx.sessions.get(sessionId)
  if (!session) return json({ ok: false, reason: 'session-not-active' }, 409)
  const seq = session.seq
  const isCurrent = () => ctx.sessions.get(sessionId) === session && session.seq === seq
  let events, target, marker, files = [], token
  try {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    events = snapshot.events
    if (!isCurrent() || events.length !== seq) return stale()
    if (openTurn(events) !== undefined) return json({ ok: false, reason: 'session-busy' }, 409)
    target = rewindTarget(events, messageId)
    if (target.kind === 'error') return json({ ok: false, reason: target.reason }, 409)
    if (!target.text.length) return json({ ok: false, reason: 'empty-message' }, 409)
    marker = planRewind(events, session.surface.nodes, target.seq)
    if (marker.kind === 'error') return confirm ? stale() : json({ ok: false, reason: marker.reason }, 409)
    const sign = value => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex')
    const revision = sign([sessionId, messageId, target.text, seq, marker.options])
    if (confirm && previewToken.split(':')[0] !== revision) return stale()
    if (!confirm || revertFiles) {
      files = await planReverts(ctx, session, snapshot, marker.options.sourceEventSeqs)
      const fileRevision = sign([revision, files.map(f => [f.path, f.target?.targetKey, f.version, f.action, f.status, f.reason])])
      token = `${revision}:${fileRevision}`
      if (confirm && previewToken !== token) return stale()
    }
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-context-tree planning failed for %s: %o', sessionId, error)
    return json({ ok: false, reason: 'read-failed' }, 500)
  }
  // No await between the final revision check and append. Includes races with
  // other previews, concurrent confirmations, and turns begun during FS reads.
  if (!isCurrent()) return stale()
  if (!confirm) return json({ ok: true, text: target.text, files: publicFiles(files), previewToken: token })
  let committed
  try {
    committed = session.append(marker.type, marker.data, marker.options)
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-context-tree append failed for %s: %o', sessionId, error)
    return json({ ok: false, reason: 'append-rejected' }, 409)
  }
  const mask = rewindMask([...events, committed])
  try {
    if (await ctx.sessions.flush(session) !== true) throw new Error('no durability listener')
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-context-tree flush failed for %s: %o', sessionId, error)
    // append already happened in memory. Never retry it or mutate files.
    return json({ ok: false, reason: 'flush-failed', mask, text: target.text }, 503)
  }
  return json({ ok: true, text: target.text, mask,
    ...(revertFiles ? { files: await applyRevert(ctx, session, files) } : {}) })
}

/**
 * Report where earlier rewinds already cut this session.
 *
 * The Client calls this when a Chat mounts, so a reloaded page hides the same
 * rows the model can no longer see instead of trusting in-memory state.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Request} request - Incoming same-origin request.
 * @returns {Promise<Response>} JSON cut description.
 */
async function handleCut(ctx, request) {
  const parsed = await readSessionTarget(request)
  if (parsed.response !== undefined) return parsed.response

  try {
    const snapshot = await ctx.sessionQuery.readSession(parsed.sessionId)
    return json({ ok: true, ...rewindMask(snapshot.events) })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-context-tree cut failed for %s: %o', parsed.sessionId, error)
    return json({ ok: false, reason: 'read-failed' }, 500)
  }
}

/**
 * Build a revert plan for every file the cut touched.
 *
 * Reads are advisory: a file that cannot be read is reported and skipped, never
 * guessed at. The sandbox policy is resolved once per session so the plan, the
 * write, and the delete all agree about what the session is allowed to do.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {object} session - Live session from `ctx.sessions`.
 * @param {{ events: readonly object[], inheritedEventCount: number }} snapshot - Log and its ownership boundary, from one observation.
 * @param {readonly number[]} suffix - Exact visible surface nodes being replaced.
 * @returns {Promise<object[]>} Internal plan entries.
 */
async function planReverts(ctx, session, { events, inheritedEventCount }, suffix) {
  // Older/incomplete snapshots cannot establish which file actions we own.
  // The conversation itself is still safe to rewind.
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length) return []
  const groups = groupByPath(collectFileChanges(events, -1, new Set(suffix), inheritedEventCount))
  if (!groups.length) return []
  const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : '.'
  const policy = ctx.sandboxPolicy.resolve({ session })
  const files = []

  for (const group of groups) {
    const file = {
      path: group.path,
      label: labelOf(cwd, group.path),
      action: group.createdAfterCut ? 'delete' : 'restore',
      status: 'ok',
      diffs: displayDiffs(group),
      diffOmitted: false,
    }

    try {
      const target = await ctx.fs.resolve(group.path, { cwd })
      file.target = target
      if (!await allows(ctx, policy, target)) {
        file.status = 'blocked'
        file.reason = 'sandbox'
        files.push(file)
        continue
      }

      // Native tool metadata records processPath, not the (possibly aliased)
      // displayPath or the opaque targetKey. A different parent can redirect
      // even a regular leaf to identical bytes inside the same workspace.
      if (typeof ctx.fs.processPath !== 'function' || typeof ctx.fs.lstat !== 'function') {
        files.push(Object.assign(file, { status: 'blocked', reason: 'unsupported' }))
        continue
      }
      if (ctx.fs.processPath(target) !== group.path) {
        files.push(Object.assign(file, { status: 'blocked', reason: 'unproven' }))
        continue
      }
      const entry = await ctx.fs.lstat(group.path, { cwd })
      const info = await ctx.fs.stat(target)
      if (info === undefined && entry === undefined) {
        const plan = planFileRevert(group, null)
        file.action = plan.action
        file.status = plan.status
        if (plan.reason !== undefined) file.reason = plan.reason
        files.push(file)
        continue
      }
      if (info?.type !== 'file' || entry?.type !== 'file') {
        file.status = 'blocked'
        file.reason = 'not-a-file'
        files.push(file)
        continue
      }
      if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > REVERT_MAX_BYTES) {
        file.status = 'blocked'
        file.reason = 'too-large'
        files.push(file)
        continue
      }

      if (typeof ctx.fs.readBytes !== 'function') {
        files.push(Object.assign(file, { status: 'blocked', reason: 'unsupported' }))
        continue
      }
      file.version = info.version
      const bytes = await ctx.fs.readBytes(target, undefined, REVERT_MAX_BYTES)
      const current = decodeExact(bytes, info.size)
      const plan = typeof info.version !== 'string' || current === undefined
        ? { action: file.action, status: 'conflict', reason: 'unproven' }
        : planFileRevert(group, current)
      file.action = plan.action
      file.status = plan.status
      if (plan.reason !== undefined) file.reason = plan.reason
      if (file.action === 'delete' && file.status === 'ok') {
        if (typeof ctx.fs.deleteFile !== 'function') Object.assign(file, { status: 'blocked', reason: 'unsupported' })
        else file.diffs = [{ path: group.path, oldText: null, newText: current }]
      }
    } catch (error) {
      const tooLarge = error?.code === 'FS_TOO_LARGE'
      file.status = tooLarge ? 'blocked' : 'unreadable'
      file.reason = tooLarge ? 'too-large' : typeof error?.code === 'string' ? error.code : 'unreadable'
      file.diffs = []
    }
    files.push(file)
  }
  for (const file of files) capDiffs(file)
  return files
}

/** Reject malformed UTF-8; preserve an initial BOM as content, not a decoder directive. */
function decodeExact(bytes, size) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) return undefined
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return undefined }
}

/** Apply exactly the checked plan, never replan after committing the marker. */
async function applyRevert(ctx, session, plan) {
  const results = []
  for (const file of plan) {
    const result = { path: file.path, action: file.action, status: file.status, reason: file.reason }
    results.push(result)
    if (file.status !== 'ok' || file.action === 'already-absent') continue
    try {
      // The current log format proves certain creations, not preexisting bytes.
      // Fail closed on any other action; never translate provider paths to Host paths.
      const policy = ctx.sandboxPolicy.resolve({ session })
      const fresh = await ctx.fs.resolve(file.path, { cwd: session.header?.cwd })
      if (!await allows(ctx, policy, fresh)) {
        Object.assign(result, { status: 'blocked', reason: 'sandbox' })
      } else if (fresh.targetKey !== file.target.targetKey || ctx.fs.processPath(fresh) !== file.path) {
        Object.assign(result, { status: 'blocked', reason: 'changed' })
      } else if (file.action === 'delete') {
        await ctx.fs.deleteFile(fresh, { version: file.version }, undefined, policy)
      } else {
        Object.assign(result, { status: 'blocked', reason: 'unproven' })
      }
    } catch (error) {
      result.reason = errorReason(error, file.action)
      result.status = result.reason === 'absent' ? 'ok' : 'failed'
    }
  }
  return results
}

/**
 * Whether the session's sandbox lets this plugin touch a target.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {{ mode?: string, workspaceRoot?: string }} policy - Resolved sandbox policy.
 * @param {{ targetKey: string, displayPath: string }} target - Resolved file target.
 * @returns {Promise<boolean>} True when a write or delete may proceed.
 */
async function allows(ctx, policy, target) {
  if (policy?.mode !== 'workspace-write' && policy?.mode !== 'danger-full-access') return false
  // DSH resolves workspaceRoot even for full-access sessions (recorded cwd,
  // or its configured fallback). Extra writable roots aren't rewind scope.
  if (typeof policy.workspaceRoot !== 'string' || !isAbsolute(policy.workspaceRoot)
    || policy.workspaceRoot.includes('\0') || typeof ctx.fs.contains !== 'function') return false
  const root = await ctx.fs.resolve(policy.workspaceRoot, {})
  return await ctx.fs.contains(root, target) === true
}

/**
 * Plan entries without their Host handles, ready for JSON.
 * @param {readonly object[]} files - Internal plan entries.
 * @returns {object[]} Public preview entries.
 */
function publicFiles(files) {
  return files.map(file => ({
    path: file.path,
    label: file.label,
    action: file.action,
    status: file.status,
    ...(file.reason === undefined ? {} : { reason: file.reason }),
    diffs: file.diffs ?? [],
    ...(file.diffOmitted ? { diffOmitted: true } : {}),
  }))
}

/**
 * Human-facing path: relative to the session cwd when it lives below it.
 * @param {string} cwd - Session working directory.
 * @param {string} path - Absolute file path.
 * @returns {string} Label for the confirmation dialog.
 */
function labelOf(cwd, path) {
  const rel = relative(cwd, path)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return path
  return rel
}

/**
 * Recorded hunks for display, in log order.
 * @param {{ path: string, changes: object[] }} group - One path's changes.
 * @returns {{ path: string, oldText: string | null, newText: string }[]} Hunks.
 */
function displayDiffs(group) {
  const diffs = []
  for (const change of group.changes) {
    for (const diff of change.diffs) {
      diffs.push({ path: group.path, oldText: diff.oldText, newText: diff.newText })
    }
  }
  return diffs
}

/**
 * Drop an oversized diff from the preview while keeping the file row.
 * @param {object} file - Internal plan entry.
 * @returns {void}
 */
function capDiffs(file) {
  const size = (file.diffs ?? []).reduce((total, diff) => total + (diff.oldText?.length ?? 0) + diff.newText.length, 0)
  if (size <= DIFF_MAX_CHARS) return
  file.diffs = []
  file.diffOmitted = true
}

/**
 * Map a filesystem failure onto a stable, translatable reason.
 * @param {unknown} error - Thrown filesystem error.
 * @param {string} action - `restore` or `delete`.
 * @returns {string} Stable reason.
 */
function errorReason(error, action) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'ENOENT') return action === 'delete' ? 'absent' : 'missing'
  if (code === 'FS_STALE_VERSION' || code === 'EISDIR' || code === 'ENOTDIR') return 'changed'
  if (code === 'FS_SANDBOX_DENIED' || code === 'EACCES' || code === 'EPERM') return 'sandbox'
  if (code === 'FS_NOT_FOUND') return action === 'delete' ? 'absent' : 'missing'
  if (code === 'unsupported') return 'unsupported'
  return 'failed'
}

/**
 * Validate the envelope and a session-only payload.
 * @param {Request} request - Incoming request.
 * @returns {Promise<{ sessionId: string, response?: Response }>} Target or an early response.
 */
async function readSessionTarget(request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return { response: parsed.response }
  const { sessionId } = parsed.body
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { response: json({ ok: false, reason: 'invalid-request' }, 400) }
  }
  return { sessionId }
}

/**
 * Validate the shared request envelope and payload.
 * @param {Request} request - Incoming request.
 * @returns {Promise<{ sessionId: string, messageId: string, revertFiles: boolean, previewToken?: string, response?: Response }>} Target or an early response.
 */
async function readTarget(request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return { response: parsed.response }
  const { sessionId, messageId, revertFiles, previewToken } = parsed.body
  if (typeof sessionId !== 'string' || sessionId.length === 0
    || typeof messageId !== 'string' || messageId.length === 0) {
    return { response: json({ ok: false, reason: 'invalid-request' }, 400) }
  }
  return { sessionId, messageId, revertFiles: revertFiles === true, previewToken }
}

/**
 * Validate method, origin fence, and body shape shared by every route.
 * @param {Request} request - Incoming request.
 * @returns {Promise<{ body?: Record<string, unknown>, response?: Response }>} Parsed body or an early response.
 */
async function readBody(request) {
  if (request.method !== 'POST') return { response: json({ ok: false, reason: 'method-not-allowed' }, 405) }
  if (!isSameOriginJson(request)) return { response: json({ ok: false, reason: 'forbidden' }, 403) }

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return { response: json({ ok: false, reason: 'body-too-large' }, 413) }

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return { response: json({ ok: false, reason: 'invalid-request' }, 400) }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { response: json({ ok: false, reason: 'invalid-request' }, 400) }
  }
  return { body }
}

/**
 * Reject non-JSON and cross-authority mutations; the browser's same-origin
 * policy already blocks the latter, and the explicit check keeps non-browser
 * callers honest.
 * @param {Request} request - Incoming request.
 * @returns {boolean} Whether the request may reach a handler.
 */
function isSameOriginJson(request) {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return false
  if (request.headers.get('x-dk-context-tree') !== '1') return false
  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    const source = new URL(origin)
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin) return false
    const host = request.headers.get('host') ?? new URL(request.url).host
    return new URL(`${source.protocol}//${host}`).host === source.host
  } catch {
    return false
  }
}

/**
 * Serialize a no-store JSON response.
 * @param {unknown} body - Response payload.
 * @param {number} [status] - HTTP status.
 * @returns {Response} JSON response.
 */
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}
