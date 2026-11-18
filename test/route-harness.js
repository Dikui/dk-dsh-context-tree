import { apply, CUT_ROUTE, PREVIEW_ROUTE, TRUNCATE_ROUTE } from '../index.js'

// Raw log and ordered message surface are separate in DSH. Only appends to
// message-producing event types add a node; replace splices by node position.
export function harness({ files = new Map(), policy = { mode: 'workspace-write', workspaceRoot: '/w' }, flush = async () => true } = {}) {
  const events = [], nodes = [], mutations = [], routes = new Map()
  const session = {
    header: { cwd: '/w' }, surface: { nodes }, get seq() { return events.length },
    append(type, data, intent = {}) {
      const seq = events.length
      const event = { type, data, seq, time: seq, ...intent }
      const op = intent.surfaceOp
      if (op === 'append') nodes.push(seq)
      else if (op?.op === 'replace') {
        const from = nodes.indexOf(op.startSeq), to = nodes.indexOf(op.endSeq)
        if (from === -1 || to < from) throw new Error('invalid surface range')
        nodes.splice(from, to - from + 1, seq)
      }
      events.push(event)
      return event
    },
  }
  const ctx = {
    effect: register => register(), logger: { warn() {} },
    connection: { fetch: { register: route => routes.set(route.path, route.fetch) } },
    sessionQuery: { readSession: async () => ({ events: events.slice(), inheritedEventCount: 0 }) },
    sessions: { get: id => id === 's' ? session : undefined, flush },
    sandboxPolicy: { resolve: () => policy },
    fs: {
      resolve: async path => ({ targetKey: path, displayPath: path }),
      processPath: target => target.targetKey,
      contains: (parent, child) => child.targetKey.startsWith(parent.targetKey + '/'),
      lstat: async path => files.has(path) ? { type: 'file' } : undefined,
      stat: async ({ targetKey }) => {
        const f = files.get(targetKey)
        return f && { version: f.version, type: 'file', size: Buffer.byteLength(f.content) }
      },
      readText: async ({ targetKey }) => files.get(targetKey).content.toString(),
      readBytes: async ({ targetKey }, _signal, maxBytes) => {
        const { content } = files.get(targetKey)
        if (Buffer.byteLength(content) > maxBytes) throw Object.assign(new Error(), { code: 'FS_TOO_LARGE' })
        return Buffer.from(content)
      },
      deleteFile: async (target, expected, _signal, sandboxPolicy) => {
        if (files.get(target.targetKey)?.version !== expected.version) throw Object.assign(new Error(), { code: 'FS_STALE_VERSION' })
        mutations.push({ action: 'delete', path: target.targetKey, expected, policy: sandboxPolicy })
        files.delete(target.targetKey)
      },
      writeText: async (target, content, expected, _signal, sandboxPolicy) => {
        if (files.get(target.targetKey)?.version !== expected.version) throw Object.assign(new Error(), { code: 'FS_STALE_VERSION' })
        mutations.push({ action: 'restore', path: target.targetKey, expected, content, policy: sandboxPolicy })
        files.set(target.targetKey, { content, version: 'after' })
      },
    },
  }
  apply(ctx)
  function turn(n, id, work = () => {}) {
    session.append('turn/start', { turn: n })
    session.append('step/start', { turn: n, step: 1 })
    const prompt = session.append('user/message', { id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    work()
    session.append('assistant/message', { turn: n, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: n, step: 1 })
    session.append('turn/end', { turn: n })
    return prompt.seq
  }
  function fileResult(n, path, args, operation, diffs = []) {
    const callId = `c-${session.seq}`
    const call = session.append('tool/call', { turn: n, step: 1, callId, name: operation ? 'write' : 'edit', arguments: JSON.stringify({ file_path: path, ...args }) })
    return session.append('tool/result', {
      turn: n, step: 1, message: { id: `r-${callId}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [], isError: false },
      meta: { path, ...(operation ? { operation } : {}), diffs },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  }
  async function request(route, body) {
    const response = await routes.get(route)(new Request(`http://localhost${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dk-context-tree': '1' }, body: JSON.stringify(body) }))
    return response.json()
  }
  return { ctx, session, routes, events, mutations, files, turn, fileResult,
    preview: messageId => request(PREVIEW_ROUTE, { sessionId: 's', messageId }),
    confirm: (messageId, previewToken, revertFiles = false) => request(TRUNCATE_ROUTE, { sessionId: 's', messageId, previewToken, revertFiles, markerMode: 'notice-v1' }),
    cut: () => request(CUT_ROUTE, { sessionId: 's' }),
  }
}
