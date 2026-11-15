/**
 * Client half of dk-dsh-context-tree.
 *
 * Every user message gets one extra icon next to its copy button. Pressing it
 * rewinds the conversation to just before that message, in place: the Host
 * appends one `user/message` carrying a `surfaceOp: replace` over the live
 * surface suffix, so the model stops seeing everything from that message on
 * without any new session being created. The original text then lands back in
 * the composer for the user to edit and send again.
 *
 * The Chat paints one row per appended event and never removes a row, so the
 * Client hides the shadowed rows itself and rebuilds that hiding from the log on
 * every mount — page memory is not a source of truth.
 */
window.__ModuleLoader__.load({
  id: 'dk-dsh-context-tree',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace of this plugin. */
    const NS = 'dk-dsh-context-tree'
    /** Same-origin route that performs the in-place rewind. */
    const TRUNCATE_ROUTE = '/api/dk-dsh-context-tree/truncate'
    /** Same-origin route reporting where an earlier rewind already cut. */
    const CUT_ROUTE = '/api/dk-dsh-context-tree/cut'

    const messages = {
      en: {
        rewind: 'Rewind to here',
        planning: 'Preparing…',
        rewound: 'Rewound in place — edit and send',
        'plan-failed': 'The rewind failed',
        'empty-log': 'This conversation has no history yet',
        'empty-message': 'This message has no text to rewind to',
        'unknown-message': 'This message is no longer available',
        'not-surface-node': 'This message is no longer in the model context',
        'session-busy': 'Wait for the current reply to finish',
        'session-not-active': 'This conversation is not open in the Host',
        'append-rejected': 'The Host rejected the rewind',
        'read-failed': 'Could not read this conversation',
        'invalid-request': 'The request was rejected',
        forbidden: 'The request was rejected',
        'body-too-large': 'The request was too large',
        'method-not-allowed': 'The request was rejected',
      },
      zh: {
        rewind: '回到这里',
        planning: '准备中…',
        rewound: '已在原会话回退，可以修改后发送',
        'plan-failed': '回退失败',
        'empty-log': '这个会话还没有历史',
        'empty-message': '这条消息没有可回退的文字',
        'unknown-message': '这条消息已不可用',
        'not-surface-node': '这条消息已不在模型上下文中',
        'session-busy': '当前回复还没结束，请稍后再试',
        'session-not-active': '这个会话没有在宿主机里打开，无法原地回退',
        'append-rejected': '宿主机拒绝了这次回退',
        'read-failed': '无法读取这个会话',
        'invalid-request': '请求被拒绝',
        forbidden: '请求被拒绝',
        'body-too-large': '请求过大',
        'method-not-allowed': '请求被拒绝',
      },
    }

    /* dc:mask:start */
    /**
     * Transcript masking for an in-place rewind.
     *
     * The Chat renders one row per appended event and never removes a row, so a
     * `replace` changes what the model reads while the screen keeps the old
     * transcript. This factory hides the rows the replacement shadowed, keeps
     * them hidden across re-renders, and can start over from the log.
     *
     * Shadowing is decided by identity, never by "everything below this row":
     * user-row node keys carry the durable message id, rows carry their turn
     * number, and both come from the Host's own fold of the log. A user who
     * rewinds and then types a new message keeps that new message visible.
     *
     * Kept as a self-contained factory so tests can load this exact source.
     *
     * @param {object} dom - Environment.
     * @param {Document} dom.document - Document the Chat renders into.
     * @param {typeof MutationObserver} [dom.MutationObserver] - Observer used to survive re-renders.
     * @returns {object} Mask handle.
     */
    function createRowMask(dom) {
      const doc = dom.document
      const Observer = dom.MutationObserver
      const ROW = '[data-chat-flow-key]'
      const HIDDEN = 'data-dk-ct-hidden'
      const MARKER = 'rewind-'
      let keys = new Set()
      let turns = new Set()
      let ids = new Set()
      let observer = null

      function rows() {
        if (doc === undefined || doc === null) return []
        return Array.from(doc.querySelectorAll(ROW))
      }

      /**
       * Read the durable message id out of a Chat node key.
       *
       * Chat keys conversation nodes with `conversationContextKey(kind, id)`
       * (`<kind length>:<kind><id>`); user and steering rows share the
       * `input-message` definition kind, and the trailing remainder is the
       * message's own durable `data.id`.
       * @param {string | null} key - `data-chat-node-key`.
       * @returns {string | null} Message id, or null for any other row.
       */
      function messageIdOf(key) {
        if (typeof key !== 'string') return null
        const prefix = /^(\d+):/.exec(key)
        if (prefix === null) return null
        const kindLength = Number(prefix[1])
        const start = prefix[0].length
        if (key.slice(start, start + kindLength) !== 'input-message') return null
        const id = key.slice(start + kindLength)
        return id.length === 0 ? null : id
      }

      function isShadowed(row) {
        const nodeKey = row.getAttribute('data-chat-node-key')
        if (nodeKey !== null && nodeKey.includes(MARKER)) return true
        const key = row.getAttribute('data-chat-flow-key')
        if (key !== null && keys.has(key)) return true
        if (turns.size > 0) {
          const value = Number(row.getAttribute('data-chat-turn'))
          if (Number.isFinite(value) && turns.has(value)) return true
        }
        if (ids.size > 0) {
          const id = messageIdOf(nodeKey)
          if (id !== null && ids.has(id)) return true
        }
        return false
      }

      function hide(row) {
        const key = row.getAttribute('data-chat-flow-key')
        if (key !== null) keys.add(key)
        if (row.getAttribute(HIDDEN) === '1') return
        row.setAttribute(HIDDEN, '1')
        row.style.display = 'none'
      }

      /**
       * Rail marks of the right-hand turn navigator.
       *
       * The navigator is built from the turn outline projection and the loaded
       * timeline, so it still lists turns the model can no longer see. Its marks
       * carry the turn number only in their accessible label, which is the one
       * handle a plugin has without patching the component.
       * @returns {Element[]} Mark buttons.
       */
      function railMarks() {
        if (doc === undefined || doc === null) return []
        const marks = []
        for (const nav of doc.querySelectorAll('nav')) {
          for (const button of nav.querySelectorAll('button[data-index]')) marks.push(button)
        }
        return marks
      }

      /**
       * Turn number a rail mark points at.
       * @param {Element} mark - Navigator mark button.
       * @returns {number | null} Turn, when the label carries exactly one number.
       */
      function turnOfMark(mark) {
        const label = mark.getAttribute('aria-label')
        if (typeof label !== 'string') return null
        const matches = label.match(/\d+/g)
        if (matches === null || matches.length !== 1) return null
        return Number(matches[0])
      }

      function hideRail() {
        if (turns.size === 0) return 0
        let hidden = 0
        for (const mark of railMarks()) {
          const value = turnOfMark(mark)
          if (value === null || !turns.has(value)) continue
          if (mark.getAttribute(HIDDEN) === '1') continue
          mark.setAttribute(HIDDEN, '1')
          mark.style.display = 'none'
          hidden += 1
        }
        return hidden
      }

      function reapply() {
        for (const row of rows()) if (isShadowed(row)) hide(row)
        hideRail()
      }

      function watch() {
        if (observer !== null || Observer === undefined || doc === undefined || doc === null) return
        observer = new Observer(() => { reapply() })
        observer.observe(doc.body, { childList: true, subtree: true })
      }

      return {
        messageIdOf,
        maskFromRow(row) {
          const all = rows()
          const index = all.indexOf(row)
          const targets = index >= 0 ? all.slice(index) : [row]
          for (const target of targets) hide(target)
          reapply()
          watch()
          return targets.length
        },
        maskRanges(ranges) {
          if (ranges === null || typeof ranges !== 'object') return 0
          if (Array.isArray(ranges.turns)) for (const value of ranges.turns) if (typeof value === 'number') turns.add(value)
          if (Array.isArray(ranges.messageIds)) for (const value of ranges.messageIds) if (typeof value === 'string') ids.add(value)
          reapply()
          watch()
          return turns.size + ids.size
        },
        reapply,
        clear() {
          if (doc !== undefined && doc !== null) {
            for (const row of doc.querySelectorAll(`[${HIDDEN}="1"]`)) {
              row.removeAttribute(HIDDEN)
              row.style.display = ''
            }
          }
          keys = new Set()
          turns = new Set()
          ids = new Set()
          observer?.disconnect()
          observer = null
        },
      }
    }
    /* dc:mask:end */

    const mask = createRowMask({
      document: typeof document === 'undefined' ? undefined : document,
      MutationObserver: typeof MutationObserver === 'function' ? MutationObserver : undefined,
    })

    /** Rewind glyph, drawn like the neighbouring Chat action icons. */
    const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"'
      + ' stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M3.2 6.4h6.1a3.4 3.4 0 0 1 0 6.8H6.6"/>'
      + '<path d="M5.8 3.4 2.8 6.4l3 3"/></svg>'

    /**
     * POST one JSON payload to a same-origin Host route.
     * @param {string} route - Route path registered by the Host half.
     * @param {Record<string, string>} body - Payload for the route.
     * @returns {Promise<object>} Whatever JSON the route answered.
     */
    async function post(route, body) {
      const response = await fetch(route, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Dk-Context-Tree': '1' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => null)
      if (data === null || typeof data !== 'object') throw new Error('plan-failed')
      return data
    }

    /** Sessions whose mask has already been rebuilt from the log this page load. */
    const restored = new Set()

    /**
     * Ask the Host where this session was already cut and hide from there down.
     *
     * The click path learns the cut from its own response, which dies with the
     * page module. Rebuilding it from the log makes a reload, a bundle reload or
     * a second window show the same transcript the model sees, instead of
     * quietly revealing every shadowed turn again.
     * @param {string} sessionId - Session shown in the Chat.
     * @returns {Promise<void>} Resolves once the mask was applied or abandoned.
     */
    async function restoreMask(sessionId) {
      if (restored.has(sessionId)) return
      restored.add(sessionId)
      let outcome
      try {
        outcome = await post(CUT_ROUTE, { sessionId })
      } catch {
        return
      }
      if (outcome.ok !== true) return
      const turns = Array.isArray(outcome.turns) ? outcome.turns : []
      const messageIds = Array.isArray(outcome.messageIds) ? outcome.messageIds : []
      if (turns.length === 0 && messageIds.length === 0) return
      mask.maskRanges({ turns, messageIds })
    }

    /**
     * Find the icon row that carries the copy button of one Chat row.
     *
     * Chat renders a message's copy/time actions inside a row of icon buttons
     * that the plugin cannot address by class (CSS modules hash the names), so
     * the row is located through its copy button and returned for mounting.
     * @param {Element} row - Row wrapper carrying the Chat data attributes.
     * @returns {Element | null} Element to append the icon to.
     */
    function iconRowOf(row) {
      const buttons = Array.from(row.querySelectorAll('button'))
        .filter(button => button.dataset.dkCt === undefined)
      const copy = buttons[buttons.length - 1]
      if (copy === undefined) {
        const children = Array.from(row.children)
        for (let i = children.length - 1; i >= 0; i -= 1) {
          if (children[i].querySelector('button') !== null) return children[i]
        }
        return null
      }
      const parent = copy.parentElement
      return parent === null || parent === row ? null : parent
    }

    /**
     * Map a Host failure reason onto a locale key.
     * @param {unknown} error - Thrown error carrying a stable reason.
     * @returns {string} Locale key that always resolves.
     */
    function reasonKey(error) {
      const reason = error instanceof Error ? error.message : ''
      return typeof messages.en[reason] === 'string' ? reason : 'plan-failed'
    }

    /**
     * Seat for one message's rewind icon.
     *
     * The Chat exposes no slot inside a user message's actions row, so the seat
     * renders an invisible anchor and mounts the icon as a sibling of the copy
     * button inside that row. The icon is a real DOM button, not a React one,
     * because it lives in a subtree React does not own; the handler still runs
     * inside this component's closure.
     * @param {object} props - Slot props plus the Host context and translator.
     * @returns {object} React element.
     */
    function RowAction(props) {
      const anchor = React.useRef(null)
      const tr = props.tr
      const sessionId = props.sessionId
      const inputActions = props.inputActions

      React.useEffect(() => {
        const seat = anchor.current
        if (seat === null || typeof sessionId !== 'string') return undefined
        const row = seat.closest('[data-chat-node-key]')
        if (row === null) return undefined
        const messageId = mask.messageIdOf(row.getAttribute('data-chat-node-key'))
        if (messageId === null) return undefined
        const actions = iconRowOf(row)
        if (actions === null) return undefined

        // Rebuild any earlier cut before painting this row's icon: a reloaded
        // page has no in-memory mask, and the log is the only source of truth.
        void restoreMask(sessionId)

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dk-ct-action'
        button.dataset.dkCt = 'rewind'
        button.title = tr('rewind')
        button.setAttribute('aria-label', tr('rewind'))
        button.innerHTML = ICON
        let disposed = false
        let resetTimer

        function settle(state, title) {
          button.dataset.dkCtState = state
          button.title = title
          button.setAttribute('aria-label', title)
          clearTimeout(resetTimer)
          resetTimer = setTimeout(() => {
            if (disposed) return
            delete button.dataset.dkCtState
            button.title = tr('rewind')
            button.setAttribute('aria-label', tr('rewind'))
          }, 3000)
        }

        async function rewind() {
          if (button.dataset.dkCtState === 'busy') return
          // Hide before the round-trip: the click must look instant, and the
          // mutation below is what the user is asking for.
          mask.maskFromRow(row)
          settle('busy', tr('planning'))
          try {
            const outcome = await post(TRUNCATE_ROUTE, { sessionId, messageId })
            if (disposed) return
            if (outcome.ok !== true) throw new Error(typeof outcome.reason === 'string' ? outcome.reason : 'plan-failed')
            const text = typeof outcome.text === 'string' ? outcome.text : ''
            if (typeof inputActions?.setDraft !== 'function') throw new Error('plan-failed')
            inputActions.setDraft(text)
            mask.maskRanges(outcome.mask)
            settle('done', tr('rewound'))
          } catch (error) {
            if (disposed) return
            mask.clear()
            settle('failed', tr(reasonKey(error)))
          }
        }

        const onClick = () => { void rewind() }
        button.addEventListener('click', onClick)
        actions.appendChild(button)

        // React owns that row and may re-create its children on a re-render;
        // put the icon back when it gets detached instead of losing it.
        const observer = new MutationObserver(() => {
          if (disposed) return
          if (!button.isConnected) actions.appendChild(button)
        })
        observer.observe(actions, { childList: true })

        return () => {
          disposed = true
          clearTimeout(resetTimer)
          observer.disconnect()
          button.removeEventListener('click', onClick)
          button.remove()
        }
      }, [tr, sessionId, inputActions])

      return h('span', { ref: anchor, hidden: true, 'data-dk-ct': 'anchor' })
    }

    const STYLE_ID = 'dk-dsh-context-tree-styles'

    /**
     * Mount the plugin stylesheet once and return its removal.
     * @returns {() => void} Cleanup.
     */
    function installStyles() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) return () => {}
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = `
.dk-ct-action{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta, 0px));height:calc(28px + var(--dsh-content-font-delta, 0px));padding:6px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8b8f98);cursor:pointer;font-family:inherit}
.dk-ct-action svg{width:calc(15px + var(--dsh-content-font-delta, 0px));height:calc(15px + var(--dsh-content-font-delta, 0px))}
@media (hover:hover){.dk-ct-action:hover:not([data-dk-ct-state='busy']){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#6b7280)}}
.dk-ct-action[data-dk-ct-state='busy']{cursor:default;opacity:.5}
.dk-ct-action[data-dk-ct-state='failed']{color:var(--dsw-alias-status-danger,#d64545)}
.dk-ct-action[data-dk-ct-state='done']{color:var(--dsw-alias-brand-primary,#247bbf)}
`
      document.head.appendChild(element)
      return () => element.remove()
    }

    return {
      name: NS,
      inject: ['locale', 'slots'],
      apply(ctx) {
        const effect = (register, label) => (typeof ctx.effect === 'function' ? ctx.effect(register, label) : register())

        ctx.locale.register(NS, messages)
        const translate = ctx.locale.bind(NS)
        const tr = key => {
          try {
            const text = translate(key)
            if (typeof text === 'string' && text.length > 0 && text !== key) return text
          } catch { /* fall through to the English source text */ }
          return messages.en[key] ?? messages.en['plan-failed']
        }

        effect(installStyles, 'dk-dsh-context-tree: styles')
        effect(() => ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
          name: 'conversation.chat.user.before',
          id: 'dk-context-tree-rewind',
          order: 40,
          locale: NS,
          // The row only exists for real user messages; every other chain entry
          // gets no icon and no DOM seat at all.
          select: props => (props?.kind === 'user' ? props : null),
        }, props => h(RowAction, { ...props, tr }))), 'dk-dsh-context-tree: message action')
      },
    }
  },
})
