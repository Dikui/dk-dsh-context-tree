/**
 * Host half of dk-dsh-context-tree.
 *
 * Two same-origin routes over Host services:
 * - `truncate` performs an in-place rewind: it appends a `user/message` that
 *   carries a `surfaceOp: replace` over the live surface suffix, so the model
 *   stops seeing that suffix without any new session being created.
 * - `cut` reports where earlier rewinds already cut a session, so the Client can
 *   rebuild its view after a reload instead of trusting page memory.
 *
 * Neither route rewrites stored events; DSH logs are append-only and a
 * replacement only shadows the surface.
 *
 * @module dk-dsh-context-tree
 */

import { buildRewindMessage, openTurn, rewindMask, rewindTarget, REWIND_SOURCE_KIND } from './src/plan.js'

/** Same-origin JSON route that performs an in-place rewind. */
export const TRUNCATE_ROUTE = '/api/dk-dsh-context-tree/truncate'

/** Same-origin JSON route reporting where an earlier rewind already cut. */
export const CUT_ROUTE = '/api/dk-dsh-context-tree/cut'

/** Largest request body accepted; every payload here is a pair of scalars. */
const MAX_BODY_BYTES = 4096

/** Host services this plugin uses. */
export const inject = ['connection', 'sessionQuery', 'sessions']

/**
 * Register both routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: TRUNCATE_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleTruncate(ctx, request),
  }), 'dk-dsh-context-tree: truncate route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: CUT_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleCut(ctx, request),
  }), 'dk-dsh-context-tree: cut route')
}

/**
 * Rewind the live session in place.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Request} request - Incoming same-origin request.
 * @returns {Promise<Response>} JSON outcome describing the truncation.
 */
async function handleTruncate(ctx, request) {
  const parsed = await readTarget(request)
  if (parsed.response !== undefined) return parsed.response

  let target
  let events = []
  try {
    const snapshot = await ctx.sessionQuery.readSession(parsed.sessionId)
    events = snapshot.events
    target = rewindTarget(events, parsed.messageId)
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-context-tree truncate read failed for %s: %o', parsed.sessionId, error)
    return json({ ok: false, reason: 'read-failed' }, 500)
  }
  if (target.kind === 'error') return json({ ok: false, reason: target.reason }, 200)
  if (target.text.length === 0) return json({ ok: false, reason: 'empty-message' }, 200)

  if (openTurn(events) !== undefined) return json({ ok: false, reason: 'session-busy' }, 409)

  const session = ctx.sessions.get(parsed.sessionId)
  if (session === undefined) return json({ ok: false, reason: 'session-not-active' }, 409)

  const startSeq = target.seq
  const nodes = [...session.surface.nodes]
  const endSeq = nodes.at(-1)
  if (endSeq === undefined || !nodes.includes(startSeq) || endSeq < startSeq) {
    return json({ ok: false, reason: 'not-surface-node' }, 409)
  }
  // Each rewind leaves its own marker on the surface. Shadow the older markers
  // too, so repeated rewinds keep one marker instead of stacking a copy of the
  // same text on the model context every time.
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const earlierMarkers = nodes.filter(seq => seq < startSeq
    && bySeq.get(seq)?.type === 'user/message'
    && bySeq.get(seq)?.data?.source?.kind === REWIND_SOURCE_KIND)
  const cutSeq = earlierMarkers.length > 0 ? Math.min(startSeq, ...earlierMarkers) : startSeq
  const shadowed = nodes.filter(seq => seq >= cutSeq && seq <= endSeq)

  let committed
  try {
    committed = session.append(
      'user/message',
      buildRewindMessage(target.text),
      { surfaceOp: { op: 'replace', startSeq: cutSeq, endSeq }, sourceEventSeqs: shadowed },
    )
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-context-tree truncate append failed for %s: %o', parsed.sessionId, error)
    return json({ ok: false, reason: 'append-rejected', message: String(error?.message ?? error) }, 409)
  }

  try {
    await ctx.sessions.flush(session)
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-context-tree truncate flush failed for %s: %o', parsed.sessionId, error)
  }

  return json({ ok: true, text: target.text, mask: rewindMask([...events, committed]) })
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
 * @returns {Promise<{ sessionId: string, messageId: string, response?: Response }>} Target or an early response.
 */
async function readTarget(request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return { response: parsed.response }
  const { sessionId, messageId } = parsed.body
  if (typeof sessionId !== 'string' || sessionId.length === 0
    || typeof messageId !== 'string' || messageId.length === 0) {
    return { response: json({ ok: false, reason: 'invalid-request' }, 400) }
  }
  return { sessionId, messageId }
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
