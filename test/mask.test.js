import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Load the row-mask factory from the *shipped* Client source.
 *
 * The factory is deliberately self-contained so it can be extracted instead of
 * re-implemented in the test: a copy would keep passing after the real one
 * broke, which is exactly how the "rows came back" regression slipped through.
 *
 * @returns {Function} `createRowMask(dom)`.
 */
function loadMaskFactory() {
  const path = fileURLToPath(new URL('../client.js', import.meta.url))
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf('    /* dc:mask:start */')
  const end = source.indexOf('    /* dc:mask:end */')
  assert.ok(start > 0 && end > start, 'mask markers must exist in client.js')
  const body = source.slice(start, end)
  return new Function(`${body}\nreturn createRowMask`)()
}

/** Minimal element: attributes, inline style, children, parent. */
class Node {
  constructor(tag, attributes = {}) {
    this.tag = tag
    this.attributes = new Map(Object.entries(attributes))
    this.style = { display: '' }
    this.children = []
    this.parent = null
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  querySelectorAll(selector) {
    return matches(this, selector, false)
  }

  append(child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  get parentElement() { return this.parent }

  get isConnected() {
    let node = this
    while (node.parent !== null) node = node.parent
    return node === document.body
  }
}

/** Very small document: enough selectors for the mask, nothing more. */
const document = {
  body: new Node('body'),
  /** Support `[attr]`, `[attr="value"]`, `tag` and `tag[attr]` only. */
  querySelectorAll(selector) {
    return matches(document.body, selector, false)
  },
}

/** Match a tiny selector subset inside one subtree. */
function matches(root, selector, includeRoot) {
  const pattern = /^([a-z]*)(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/.exec(selector)
  assert.ok(pattern, `unsupported selector: ${selector}`)
  const [, tag, name, value] = pattern
  const found = []
  const walk = node => {
    for (const child of node.children) {
      const tagOk = tag === "" || child.tag === tag
      const attrOk = name === undefined || (child.getAttribute(name) !== null
        && (value === undefined || child.getAttribute(name) === value))
      if (!includeRoot && child !== root && tagOk && attrOk) found.push(child)
      walk(child)
    }
  }
  walk(root)
  return found
}

/** Rows rendering stand-in: attributes the Chat puts on a transcript row. */
function row(flowKey, nodeKey = `13:input-message${flowKey}`) {
  const element = new Node('div', { 'data-chat-flow-key': flowKey, 'data-chat-node-key': nodeKey })
  document.body.append(element)
  return element
}

/** Collected MutationObserver callbacks, so a test can simulate a re-render. */
let observers = []

class MutationObserver {
  constructor(callback) {
    this.callback = callback
    observers.push(this)
  }

  observe() {}

  disconnect() {
    observers = observers.filter(observer => observer !== this)
  }
}

/**
 * Simulate React re-rendering the transcript: the old rows are replaced by new
 * elements carrying the same keys, and the observer must hide them again.
 * @param {Array<{ key: string, node?: string }>} spec - Rows to rebuild.
 */
function rerender(spec) {
  document.body.children = []
  for (const item of spec) row(item.key, item.node)
  for (const observer of [...observers]) observer.callback()
}

/** Build a mask bound to the fake document. */
function makeMask() {
  observers = []
  return loadMaskFactory()({ document, MutationObserver })
}

test('only the rows the Host identified as shadowed are hidden', () => {
  document.body.children = []
  const first = row('a')
  const second = row('b')
  const third = row('c')
  const mask = makeMask()

  mask.maskRanges({ messageIds: ['b', 'c'] })
  assert.equal(first.getAttribute('data-dk-ct-hidden'), null)
  assert.equal(second.getAttribute('data-dk-ct-hidden'), '1')
  assert.equal(third.getAttribute('data-dk-ct-hidden'), '1')
  assert.equal(second.style.display, 'none')
  assert.equal(first.style.display, '')
})

test('a masked turn keeps only its retained context cards, including inside a group', () => {
  document.body.children = []
  const mask = makeMask()
  const group = document.body.append(new Node('div', { 'data-chat-flow-key': 'g', 'data-chat-turn': '1' }))
  const card = group.append(new Node('div', { 'data-chat-flow-key': 'sys', 'data-chat-node-key': '14:system-message2', 'data-chat-turn': '1' }))
  const reply = group.append(new Node('div', { 'data-chat-flow-key': 'reply', 'data-chat-node-key': '9:assistant3', 'data-chat-turn': '1' }))
  mask.maskRanges({ turns: [1], retainedRowKeys: ['14:system-message2'] })
  assert.equal(group.style.display, '')
  assert.equal(card.style.display, '')
  assert.equal(reply.style.display, 'none')
  mask.maskRanges({ turns: [1] }) // a deeper cut no longer retains the card
  assert.equal(group.style.display, 'none')
  assert.equal(card.style.display, 'none')
})

test('a masked row stays hidden after React rebuilds the transcript', () => {
  document.body.children = []
  row('a')
  row('b')
  const mask = makeMask()
  mask.maskRanges({ messageIds: ['b'] })

  rerender([{ key: 'a' }, { key: 'b' }, { key: 'c' }])

  const rows = document.querySelectorAll('[data-chat-flow-key]')
  assert.equal(rows[0].getAttribute('data-dk-ct-hidden'), null, 'rows above the cut stay visible')
  assert.equal(rows[1].getAttribute('data-dk-ct-hidden'), '1', 'the cut row comes back hidden')
  assert.equal(rows[2].getAttribute('data-dk-ct-hidden'), null, 'a later row is not swept in blindly')
})

test('clearing the mask brings every hidden row back', () => {
  document.body.children = []
  row('a')
  row('b')
  const mask = makeMask()
  mask.maskRanges({ messageIds: ['b'] })
  mask.clear()

  for (const element of document.querySelectorAll('[data-chat-flow-key]')) {
    assert.equal(element.getAttribute('data-dk-ct-hidden'), null)
    assert.equal(element.style.display, '')
  }
  assert.equal(observers.length, 0, 'the observer is released')
})

test('only the exact legacy marker id from the Host is hidden', () => {
  document.body.children = []
  const marker = row('m', '13:input-messagerewind-recorded')
  const ordinary = row('u', '13:input-messageuser-rewind-note')
  const mask = makeMask()

  mask.maskRanges({ messageIds: ['rewind-recorded'] })

  assert.equal(marker.getAttribute('data-dk-ct-hidden'), '1')
  assert.equal(ordinary.getAttribute('data-dk-ct-hidden'), null)
})

test('a mask never leaks into a session that reuses turns, keys or ids', () => {
  document.body.children = []
  row('a', '13:input-messagesame')
  const mask = makeMask()
  mask.maskRanges({ turns: [3], messageIds: ['same'] })

  // The Client clears the singleton when the Chat switches sessions. Without
  // that boundary the same turn number, flow key or durable id in the next
  // session would inherit this mask and blank a conversation never rewound.
  document.body.children = []
  mask.clear()
  const foreign = row('a', '13:input-messagesame')
  foreign.setAttribute('data-chat-turn', '3')
  mask.reapply()

  assert.equal(foreign.getAttribute('data-dk-ct-hidden'), null)
})

test('a masked turn disappears from the turn navigator rail', () => {
  document.body.children = []
  const nav = new Node('nav', {})
  document.body.append(nav)
  const first = new Node('button', { 'data-index': '0', 'aria-label': 'Jump to turn 1' })
  const second = new Node('button', { 'data-index': '1', 'aria-label': '跳转到第 2 轮' })
  nav.append(first)
  nav.append(second)

  const mask = makeMask()
  mask.maskRanges({ turns: [2] })

  assert.equal(first.getAttribute('data-dk-ct-hidden'), null, 'a live turn keeps its mark')
  assert.equal(second.getAttribute('data-dk-ct-hidden'), '1', 'a shadowed turn loses its mark')
  assert.equal(second.style.display, 'none')
})

test('a mark whose label carries no turn number is left alone', () => {
  document.body.children = []
  const nav = new Node('nav', {})
  document.body.append(nav)
  const odd = new Node('button', { 'data-index': '0', 'aria-label': 'Toggle 3 of 9' })
  nav.append(odd)

  const mask = makeMask()
  mask.maskRanges({ turns: [3] })

  assert.equal(odd.getAttribute('data-dk-ct-hidden'), null, 'ambiguous labels are not guessed at')
})
