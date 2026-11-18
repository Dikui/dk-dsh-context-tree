/**
 * Client half of dk-dsh-context-tree.
 *
 * Every user message gets one extra icon next to its copy button. Pressing it
 * previews a rewind to just before that message. Only on confirmation does
 * the Host replace the live surface suffix with the fixed model-visible notice
 * “Conversation rewound.” It neither includes the removed text nor starts
 * a new model request. The original text then lands back in
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

    // Older versions registered under the plugin name without releasing it.
    const NS = 'dk-dsh-context-tree.client'
    /** Same-origin route that performs the in-place rewind. */
    const TRUNCATE_ROUTE = '/api/dk-dsh-context-tree/truncate'
    /** Same-origin route reporting where an earlier rewind already cut. */
    const CUT_ROUTE = '/api/dk-dsh-context-tree/cut'
    /** Same-origin route previewing the file changes a rewind would revert. */
    const PREVIEW_ROUTE = '/api/dk-dsh-context-tree/preview'

    const rewindEn = 'This message and everything after it will be removed. Its text will return to the composer. In their place the model will see only “Conversation rewound.” This does not start a model request.'
    const rewindZh = '这条消息及之后的对话将被移除，原文会回到输入框。模型会看到替代这段对话的固定说明「Conversation rewound.」，其中不含原文，也不会单独发起模型请求。'
    const messages = {
      en: {
        rewind: 'Rewind to here',
        planning: 'Preparing…',
        'plan-failed': 'Could not prepare the rewind. No changes were made.',
        'preview-unavailable': 'This rewind cannot be confirmed with the current plugin versions. Update the Host and client plugins, then reopen the preview.',
        'preview-stale': 'This preview is out of date. Nothing was rewound. Select “Rewind to here” again, review the new preview, and confirm.',
        'flush-failed': 'This conversation may already have been rewound, but saving its history was not confirmed. Your draft was kept. No files were changed. Check the conversation before taking further action.',
        'rewind-unconfirmed': 'The rewind result could not be confirmed. Check the conversation and files before trying again.',
        'draft-failed': 'The conversation was rewound, but its text could not be placed in the composer.',
        'mask-failed': 'The conversation was rewound, but the visible history could not be updated. Reload to check it.',
        'files-skipped': 'The conversation was rewound. Some files were not reverted:',
        'files-unconfirmed': 'The conversation was rewound, but the file results could not be confirmed.',
        'partial-turn': 'Choose the first user message of a complete turn to rewind.',
        'missing-step-position': 'The start of this turn could not be located. Only the first user message of a precisely located turn can be rewound.',
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
        confirmTitle: 'Confirm rewind',
        confirmBody: rewindEn + ' Files stay unchanged unless you select the file option.',
        confirmBodyNoFiles: rewindEn,
        revertFiles: 'Also revert file changes',
        confirmRewind: 'Confirm rewind',
        cancel: 'Cancel',
        close: 'Close',
        previewing: 'Checking file changes…',
        fileRestore: 'Restore',
        fileDelete: 'Delete',
        fileAbsent: 'Already gone',
        fileSkip: 'Skip',
        viewDiff: 'View recorded change',
        hideDiff: 'Hide diff',
        diffTooLarge: 'This diff is too large to show',
        moreLines: 'more lines',
        'reason-unproven': 'The history does not prove the exact change; this file will be left alone',
        'reason-stale': 'The file no longer matches the recorded change',
        'reason-ambiguous': 'The recorded change matches more than once',
        'reason-missing': 'The file no longer exists',
        'reason-changed': 'The file was changed after the agent edited it',
        'reason-sandbox': 'Blocked by the file sandbox',
        'reason-too-large': 'The file is too large to revert',
        'reason-unreadable': 'The file could not be read',
        'reason-not-a-file': 'Not a regular file',
        'reason-unsupported': 'This file provider cannot delete files',
        'reason-absent': 'The file is already gone',
        'reason-failed': 'The file could not be reverted',
      },
      zh: {
        rewind: '回到这里',
        planning: '准备中…',
        'plan-failed': '无法准备回退，没有做任何更改。',
        'preview-unavailable': '当前插件版本无法确认这次回退。请更新宿主端和客户端插件，再重新打开预览。',
        'preview-stale': '预览已过期，本次没有回退。请再次选择「回到这里」，查看最新预览后重新确认。',
        'flush-failed': '当前会话可能已经回退，但历史记录是否保存尚未确认。原草稿保留，文件未改动。请先检查会话状态。',
        'rewind-unconfirmed': '未能确认回退结果。请先检查会话及文件状态，再决定是否重试。',
        'draft-failed': '会话已回退，但消息文字未能放入输入框。',
        'mask-failed': '会话已回退，但页面上的历史未能更新。请刷新后查看。',
        'files-skipped': '会话已回退，以下文件未还原：',
        'files-unconfirmed': '会话已回退，但文件还原结果未能确认。',
        'partial-turn': '仅支持按整轮回退，请选择这一轮的首条用户消息。',
        'missing-step-position': '无法准确定位这轮对话的起点。仅支持从可准确定位的整轮首条用户消息回退。',
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
        confirmTitle: '确认回退',
        confirmBody: rewindZh + '默认不改动文件。勾选后仅尝试还原符合条件的更改。',
        confirmBodyNoFiles: rewindZh,
        revertFiles: '同时还原文件更改',
        confirmRewind: '确认回退',
        cancel: '取消',
        close: '关闭',
        previewing: '正在检查文件改动…',
        fileRestore: '还原',
        fileDelete: '删除',
        fileAbsent: '已不存在',
        fileSkip: '跳过',
        viewDiff: '查看原改动差异',
        hideDiff: '收起差异',
        diffTooLarge: '差异过大，无法显示',
        moreLines: '行未显示',
        'reason-unproven': '历史记录不足以证明可以精确还原，将保留文件原样',
        'reason-stale': '文件内容与记录的改动不一致',
        'reason-ambiguous': '记录的改动在文件中匹配到多处',
        'reason-missing': '文件已不存在',
        'reason-changed': '文件在代理改动之后又被修改过',
        'reason-sandbox': '被文件沙箱阻止',
        'reason-too-large': '文件过大，无法还原',
        'reason-unreadable': '无法读取文件',
        'reason-not-a-file': '不是普通文件',
        'reason-unsupported': '当前文件提供方不支持删除',
        'reason-absent': '文件已不存在',
        'reason-failed': '文件无法还原',
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
      let turns = new Set()
      let ids = new Set()
      let retainedRowKeys = new Set()
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
        const flow = rows()
        // A collapsed process group is itself a flow row. Keep its container
        // when it holds a retained card, but still mask its shadowed children.
        const keep = new Set()
        if (retainedRowKeys.size) for (const row of flow) {
          if (!retainedRowKeys.has(row.getAttribute('data-chat-node-key'))) continue
          for (let parent = row; parent; parent = parent.parentElement) keep.add(parent)
        }
        for (const row of flow) {
          if (!keep.has(row) && isShadowed(row)) hide(row)
          else if (row.getAttribute(HIDDEN) === '1') {
            row.removeAttribute(HIDDEN)
            row.style.display = ''
          }
        }
        hideRail()
      }

      function watch() {
        if (observer !== null || Observer === undefined || doc === undefined || doc === null) return
        observer = new Observer(() => { reapply() })
        observer.observe(doc.body, { childList: true, subtree: true })
      }

      return {
        messageIdOf,
        maskRanges(ranges) {
          if (ranges === null || typeof ranges !== 'object') return 0
          if (Array.isArray(ranges.turns)) for (const value of ranges.turns) if (typeof value === 'number') turns.add(value)
          if (Array.isArray(ranges.messageIds)) for (const value of ranges.messageIds) if (typeof value === 'string') ids.add(value)
          // Each Host response describes all cuts, not a delta; a later cut may
          // consume a previously retained context card.
          retainedRowKeys = new Set(ranges.retainedRowKeys ?? [])
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
          turns = new Set()
          ids = new Set()
          retainedRowKeys = new Set()
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

    /* dc:session:start */
    // A row owns a preview; the selected Session owns confirmed outcomes even
    // when Chat is temporarily absent. `mainView` is the controller's observable
    // retention source: an empty destination need not mount any rows to retire A.
    function createRewindSession({ mainView, readCut, mask }) {
      let active
      function clear() {
        active?.unsubscribe()
        active = undefined
        mask.clear()
      }
      async function refresh(state) {
        const revision = state.revision
        try {
          const cut = await readCut(state.id)
          if (active !== state || state.revision !== revision || cut?.ok !== true) return
          mask.maskRanges(cut)
          state.restored = true
        } catch { /* A later Chat mount or explicit gesture may retry this read. */ }
      }
      function restore(state) {
        return state.pending ??= refresh(state).finally(() => { state.pending = null })
      }
      return {
        clear,
        mount(id) {
          if (active?.id !== id) {
            const retained = mainView(id)
            const selected = () => (retained.getSnapshot().retainedBy.mainView ?? 0) > 0
            if (!selected()) return null
            clear()
            const state = { id, rows: 0, restored: false, revision: 0 }
            active = state
            state.unsubscribe = retained.subscribe(() => { if (active === state && !selected()) clear() })
          }
          const state = active
          if (state.rows++ === 0) state.restored = false
          const sameSession = () => active === state
          const retry = () => sameSession() && !state.restored ? restore(state) : undefined
          return {
            sameSession, ready: state.rows === 1 ? retry() : state.pending, retry,
            applyMask(ranges) {
              if (!sameSession()) return
              state.revision++
              mask.maskRanges(ranges)
              state.restored = true
            },
            release() { state.rows-- },
          }
        },
      }
    }
    /* dc:session:end */

    /* dc:rewind:start */
    function canRevert(file) {
      return file?.status === 'ok' && (file.action === 'restore' || file.action === 'delete')
    }

    // One gesture, one preview, at most one truncate. The row owns the
    // confirmation UI; the command owns the token across that decision.
    async function runRewind(o) {
      if (!o.isCurrent()) return
      const preview = await o.preview(o.target)
      if (!o.isCurrent()) return
      if (preview?.ok !== true) return o.report(preview?.reason || 'plan-failed')
      const { files, previewToken, markerMode } = preview
      if (markerMode !== 'notice-v1' || typeof previewToken !== 'string' || !previewToken.trim()) return o.report('preview-unavailable')
      if (!Array.isArray(files) || typeof preview.text !== 'string') return o.report('plan-failed')
      const choice = await o.choose({ text: preview.text, files, revertFiles: false })
      if (!o.isCurrent() || typeof choice !== 'boolean') return
      const revertFiles = choice && files.some(canRevert)
      let outcome
      try {
        outcome = await o.truncate({ ...o.target, revertFiles, previewToken, markerMode })
      } catch {
        if (o.sameSession()) o.report('rewind-unconfirmed')
        return
      }
      // Truncate is irreversible. Only a session switch (not the row's DOM
      // lifetime) cancels delivery of its draft, mask and file receipts.
      if (!o.sameSession()) return
      if (outcome?.ok !== true) {
        // The live append happened before flush failed; trust only the mask
        // explicitly returned by this Host. Do not change the existing draft.
        if (outcome?.reason === 'flush-failed' && outcome.mask) {
          try { o.applyMask(outcome.mask) } catch { o.report('mask-failed') }
          if (!o.sameSession()) return
        }
        return o.report(outcome?.reason || 'rewind-unconfirmed')
      }
      // A committed rewind cannot be undone by a client error. Keep draft,
      // transcript and file feedback independent so none hides another failure.
      try { o.applyMask(outcome.mask) } catch { o.report('mask-failed') }
      if (!o.sameSession()) return
      try {
        if (typeof outcome.text !== 'string') throw new Error()
        o.setDraft(outcome.text)
      } catch { o.report('draft-failed') }
      if (!o.sameSession() || !revertFiles) return
      if (!Array.isArray(outcome.files) || outcome.files.length !== files.length ||
          outcome.files.some(file => typeof file?.path !== 'string' || typeof file.status !== 'string')) {
        return o.report('files-unconfirmed')
      }
      const skipped = outcome.files.filter(file => file.status !== 'ok')
      if (skipped.length > 0) o.report('files-skipped', skipped)
    }
    /* dc:rewind:end */

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
     * @param {string} reason - Host or Client reason code.
     * @returns {string} Locale key that always resolves.
     */
    function reasonKey(reason) {
      return Object.hasOwn(messages.en, reason) ? reason : 'rewind-unconfirmed'
    }

    /** Small file glyph used by the confirm dialog's rows. */
    const FILE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.5h5L13 5.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.5V6h4.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'

    /**
     * Split text into diff lines without the phantom line a trailing newline
     * adds, so an emptied file does not show one empty addition.
     * @param {string | null} text - Whole-file text of one side.
     * @returns {string[]} Lines.
     */
    function diffLines(text) {
      if (typeof text !== 'string') return []
      const lines = text.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      return lines
    }

    /**
     * Render recorded hunks as add/remove lines for the preview.
     *
     * Each hunk carries context, so matching prefixes and suffixes are trimmed
     * before painting: what remains is the part the rewind would actually undo.
     * @param {object[]} diffs - `{path, oldText, newText}` hunks.
     * @returns {{rows: Array<{kind: string, text: string}>, omitted: number}} Rows.
     */
    function diffRows(diffs) {
      const rows = []
      for (const diff of diffs) {
        const before = diffLines(diff.oldText)
        const after = diffLines(diff.newText)
        let start = 0
        while (start < before.length && start < after.length && before[start] === after[start]) start += 1
        let endBefore = before.length
        let endAfter = after.length
        while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
          endBefore -= 1
          endAfter -= 1
        }
        for (let index = start; index < endBefore; index += 1) rows.push({ kind: 'del', text: before[index] })
        for (let index = start; index < endAfter; index += 1) rows.push({ kind: 'add', text: after[index] })
      }
      const omitted = Math.max(0, rows.length - 200)
      return { rows: rows.slice(0, 200), omitted }
    }

    /**
     * Translate a Host reason code when this bundle knows it.
     * @param {Function} tr - Translator.
     * @param {string} reason - Host reason code.
     * @returns {string} Localized explanation; keep unknown provider codes for diagnosis.
     */
    function reasonText(tr, reason) {
      if (typeof reason !== 'string' || reason.length === 0) return ''
      const key = 'reason-' + reason
      return Object.prototype.hasOwnProperty.call(messages.en, key) ? tr(key) : `${tr('reason-failed')} (${reason})`
    }

    /**
     * Ask before a rewind that touched files.
     *
     * Built from plain DOM on a native modal `<dialog>` instead of a UI
     * primitive: the client entry may only require `react`, and the element
     * already provides focus trapping, Escape handling and a backdrop.
     * @param {object} options - Dialog inputs.
     * @param {string} options.text - Target message from this preview.
     * @param {object[]} options.files - Previewed file plans.
     * @param {boolean} options.revertFiles - Initial file choice (off).
     * @param {Function} options.tr - Translator.
     * @param {(revertFiles: boolean) => void} options.onConfirm - Confirm handler.
     * @param {() => void} options.onDismiss - Called when closed without confirming.
     * @returns {{close: () => void}} Handle.
     */
    function openDialog(options) {
      const { files, tr, onConfirm, onDismiss } = options
      const dialog = document.createElement('dialog')
      dialog.className = 'dk-ct-dialog'
      dialog.setAttribute('aria-labelledby', 'dk-ct-dialog-title')

      const head = document.createElement('header')
      head.className = 'dk-ct-head'
      const title = document.createElement('h2')
      title.className = 'dk-ct-title'
      title.id = 'dk-ct-dialog-title'
      title.textContent = tr('confirmTitle')
      const closeButton = document.createElement('button')
      closeButton.type = 'button'
      closeButton.className = 'dk-ct-close'
      closeButton.setAttribute('aria-label', tr('close'))
      closeButton.title = tr('close')
      closeButton.textContent = '\u00d7'
      head.append(title, closeButton)

      const body = document.createElement('div')
      body.className = 'dk-ct-body'
      const description = document.createElement('p')
      description.className = 'dk-ct-desc'
      description.textContent = tr(files.length > 0 ? 'confirmBody' : 'confirmBodyNoFiles')
      const excerpt = document.createElement('blockquote')
      excerpt.className = 'dk-ct-excerpt'
      excerpt.textContent = options.text.length > 240 ? options.text.slice(0, 240) + '…' : options.text
      body.append(description, excerpt)

      const actionable = files.some(canRevert)
      let checkbox = null
      if (files.length > 0) {
        const label = document.createElement('label')
        label.className = 'dk-ct-check'
        checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = options.revertFiles === true && actionable
        checkbox.disabled = !actionable
        const text = document.createElement('span')
        text.textContent = tr('revertFiles')
        label.append(checkbox, text)
        body.append(label)
      }

      const list = document.createElement('ul')
      list.className = 'dk-ct-files'
      for (const file of files) {
        const item = document.createElement('li')
        item.className = 'dk-ct-file'
        const icon = document.createElement('span')
        icon.className = 'dk-ct-file-icon'
        icon.innerHTML = FILE_ICON
        const path = document.createElement('span')
        path.className = 'dk-ct-path'
        path.textContent = file.label
        path.title = file.path
        const skipped = file.status !== 'ok'
        const action = document.createElement('span')
        action.className = 'dk-ct-action-label'
        action.dataset.kind = skipped ? 'skip' : 'ok'
        action.textContent = file.action === 'already-absent'
          ? tr('fileAbsent')
          : skipped ? tr('fileSkip') : file.action === 'delete' ? tr('fileDelete') : tr('fileRestore')
        item.append(icon, path, action)

        if (skipped) {
          const reason = reasonText(tr, file.reason)
          if (reason.length > 0) {
            const note = document.createElement('span')
            note.className = 'dk-ct-reason'
            note.textContent = reason
            item.append(note)
          }
        }

        const shown = Array.isArray(file.diffs) ? file.diffs : []
        if (file.diffOmitted === true || shown.length > 0) {
          const toggle = document.createElement('button')
          toggle.type = 'button'
          toggle.className = 'dk-ct-view'
          toggle.textContent = tr('viewDiff')
          toggle.setAttribute('aria-expanded', 'false')
          const diff = document.createElement('pre')
          diff.className = 'dk-ct-diff'
          diff.hidden = true
          let built = false
          toggle.addEventListener('click', () => {
            if (!built) {
              built = true
              if (file.diffOmitted === true) {
                diff.textContent = tr('diffTooLarge')
              } else {
                const rendered = diffRows(shown)
                for (const row of rendered.rows) {
                  const line = document.createElement('span')
                  line.className = row.kind === 'add' ? 'dk-ct-diff-add' : 'dk-ct-diff-del'
                  line.textContent = (row.kind === 'add' ? '+' : '-') + row.text + '\n'
                  diff.append(line)
                }
                if (rendered.omitted > 0) {
                  const more = document.createElement('span')
                  more.className = 'dk-ct-diff-more'
                  more.textContent = '\u2026 ' + rendered.omitted + ' ' + tr('moreLines')
                  diff.append(more)
                }
              }
            }
            diff.hidden = !diff.hidden
            toggle.setAttribute('aria-expanded', String(!diff.hidden))
            toggle.textContent = diff.hidden ? tr('viewDiff') : tr('hideDiff')
          })
          item.append(toggle, diff)
        }
        list.append(item)
      }
      if (files.length > 0) body.append(list)

      const foot = document.createElement('footer')
      foot.className = 'dk-ct-foot'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'dk-ct-button'
      cancel.textContent = tr('cancel')
      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'dk-ct-button'
      confirm.dataset.variant = 'primary'
      confirm.textContent = tr('confirmRewind')
      foot.append(cancel, confirm)

      dialog.append(head, body, foot)
      document.body.append(dialog)

      let confirmed = false
      let closed = false
      function close() {
        if (closed) return
        closed = true
        if (dialog.open) dialog.close()
        dialog.remove()
        if (!confirmed) onDismiss()
      }

      closeButton.addEventListener('click', close)
      cancel.addEventListener('click', close)
      dialog.addEventListener('cancel', event => {
        event.preventDefault()
        close()
      })
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return
        const rect = dialog.getBoundingClientRect()
        const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom
        if (!inside) close()
      })
      confirm.addEventListener('click', () => {
        const revert = checkbox !== null && !checkbox.disabled ? checkbox.checked : false
        confirmed = true
        close()
        onConfirm(revert)
      })

      try {
        dialog.showModal()
        cancel.focus()
      } catch (error) {
        dialog.remove()
        throw error
      }
      return { close }
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

      React.useLayoutEffect(() => {
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
        const owner = props.session.mount(sessionId)
        if (!owner) return undefined

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dk-ct-action'
        button.dataset.dkCt = 'rewind'
        button.title = tr('rewind')
        button.setAttribute('aria-label', tr('rewind'))
        button.innerHTML = ICON
        let disposed = false
        let locked = false
        let dialog = null
        let resetTimer

        function idle() {
          clearTimeout(resetTimer)
          delete button.dataset.dkCtState
          button.title = tr('rewind')
          button.setAttribute('aria-label', tr('rewind'))
        }

        function settle(state, title) {
          button.dataset.dkCtState = state
          button.title = title
          button.setAttribute('aria-label', title)
          clearTimeout(resetTimer)
          // A pending preview, request or dialog owns the busy state; only a
          // settled state falls back to the plain icon on its own.
          if (state !== 'busy') {
            resetTimer = setTimeout(() => {
              if (!disposed) idle()
            }, 3000)
          }
        }

        const isCurrent = () => !disposed && owner.sameSession() && seat.isConnected

        function choose(plan) {
          return new Promise(resolve => {
            const finish = choice => { dialog = null; resolve(choice) }
            dialog = openDialog({ ...plan, tr, onConfirm: finish, onDismiss: () => finish(null) })
          })
        }

        // Host results can hide the initiating row. A native alert remains
        // readable until dismissed, without depending on that button or a timer.
        function report(key, files = []) {
          const title = tr(reasonKey(key))
          const lines = files.map(file => `${file.path}: ${reasonText(tr, file.reason) || tr('reason-failed')}`)
          window.alert([title, ...lines].join('\n'))
          if (isCurrent()) settle('failed', title)
        }

        async function rewind() {
          if (locked || !isCurrent()) return
          locked = true
          settle('busy', tr('previewing'))
          try {
            void owner.retry()
            await runRewind({
              target: { sessionId, messageId }, isCurrent, sameSession: owner.sameSession, choose, report,
              preview: body => post(PREVIEW_ROUTE, body),
              truncate: body => { settle('busy', tr('planning')); return post(TRUNCATE_ROUTE, body) },
              applyMask: owner.applyMask,
              setDraft: text => inputActions.setDraft(text),
            })
          } catch {
            if (isCurrent()) report('plan-failed')
          } finally {
            locked = false
            if (isCurrent() && button.dataset.dkCtState === 'busy') idle()
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
          owner.release()
          clearTimeout(resetTimer)
          if (dialog !== null) dialog.close()
          observer.disconnect()
          button.removeEventListener('click', onClick)
          button.remove()
        }
      }, [tr, sessionId, inputActions, props.session])

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
.dk-ct-action[data-dk-ct-state='failed']{color:var(--dsw-alias-state-error-primary,#d64545)}
.dk-ct-dialog{width:min(560px,calc(100vw - 40px));max-height:min(70vh,680px);margin:auto;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-alias-bg-layer-1,#1c1c1e);color:var(--dsw-alias-label-primary,#f2f2f2);box-shadow:0 24px 80px var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));font-family:inherit;font-size:14px;line-height:1.45}
.dk-ct-dialog[open]{display:flex;flex-direction:column}
.dk-ct-dialog::backdrop{background:var(--dsw-alias-bg-mask-3,rgba(0,0,0,.55))}
.dk-ct-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px 8px}
.dk-ct-title{margin:0;font-size:17px;font-weight:600}
.dk-ct-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8b8f98);font-size:20px;line-height:1;cursor:pointer}
.dk-ct-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dk-ct-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 20px 8px}
.dk-ct-desc{margin:6px 0 14px;color:var(--dsw-alias-label-secondary,#b6b6b6)}
.dk-ct-excerpt{margin:0 0 14px;padding-inline-start:10px;border-inline-start:2px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#b6b6b6)}
.dk-ct-check{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-weight:500;color:var(--dsw-alias-label-primary,#f2f2f2)}
.dk-ct-check input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,#247bbf)}
.dk-ct-files{list-style:none;margin:0;padding:0;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}
.dk-ct-file{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}
.dk-ct-file-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary,#8b8f98)}
.dk-ct-path{flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;color:var(--dsw-alias-label-primary,#f2f2f2)}
.dk-ct-action-label{font-size:13px;color:var(--dsw-alias-label-secondary,#b6b6b6)}
.dk-ct-action-label[data-kind='skip']{color:var(--dsw-alias-state-error-primary,#d64545)}
.dk-ct-reason{flex-basis:100%;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8f98)}
.dk-ct-view{padding:2px 0;border:none;background:transparent;color:var(--dsw-alias-brand-primary,#6aa9ff);font:inherit;font-size:13px;cursor:pointer}
.dk-ct-view:hover{text-decoration:underline}
.dk-ct-diff{flex-basis:100%;max-height:220px;overflow:auto;margin:6px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.1));font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.5;white-space:pre-wrap}
.dk-ct-diff-add{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dk-ct-diff-del{color:var(--dsw-alias-state-error-primary,#d64545)}
.dk-ct-diff-more{color:var(--dsw-alias-label-tertiary,#8b8f98)}
.dk-ct-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px 18px}
.dk-ct-button{padding:7px 16px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary,#f2f2f2);font:inherit;font-weight:500;cursor:pointer}
.dk-ct-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dk-ct-button[data-variant='primary']{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#247bbf));color:var(--dsw-alias-label-primary-inverted,#fff)}
.dk-ct-button[data-variant='primary']:hover{filter:brightness(1.08)}
.dk-ct-button:disabled{opacity:.5;cursor:default}
`
      document.head.appendChild(element)
      return () => element.remove()
    }

    return {
      name: 'dk-dsh-context-tree',
      inject: ['locale', 'slots', 'sessions'],
      apply(ctx) {
        const effect = (register, label) => (typeof ctx.effect === 'function' ? ctx.effect(register, label) : register())

        effect(() => ctx.locale.register(NS, messages), 'dk-dsh-context-tree: locale')
        const translate = ctx.locale.bind(NS)
        const tr = key => {
          try {
            const text = translate(key)
            if (typeof text === 'string' && text.length > 0 && text !== key) return text
          } catch { /* fall through to the English source text */ }
          return messages.en[key] ?? messages.en['plan-failed']
        }

        const session = createRewindSession({
          mainView: id => ctx.sessions.retainInfo(id), readCut: sessionId => post(CUT_ROUTE, { sessionId }), mask,
        })
        effect(() => session.clear, 'dk-dsh-context-tree: session lifetime')
        effect(installStyles, 'dk-dsh-context-tree: styles')
        effect(() => ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
          name: 'conversation.chat.user.before',
          id: 'dk-context-tree-rewind',
          order: 40,
          locale: NS,
          // The row only exists for real user messages; every other chain entry
          // gets no icon and no DOM seat at all.
          select: props => (props?.kind === 'user' ? props : null),
        }, props => h(RowAction, { ...props, tr, session }))), 'dk-dsh-context-tree: message action')
      },
    }
  },
})
