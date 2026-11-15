# Agent notes — dk-dsh-context-tree

## Shape

- Two halves in one bundle: Host `index.js` (two `connection.fetch` routes — `truncate` performs the rewind, `cut` is read-only) and Client `client.js` (module loader entry, one slot).
- `src/plan.js` is pure and unit-tested; keep it free of Cordis, Session Store and DOM so both halves can be reasoned about in isolation.

## Invariants

- **In-place rewind is one appended event.** `truncate` appends a `user/message` carrying `surfaceOp: { op: 'replace', startSeq, endSeq }` plus the exact `sourceEventSeqs` of the shadowed surface nodes, then awaits `ctx.sessions.flush`. Stored events are never rewritten; the log stays append-only.
- **Every appended `user/message` must carry `source.kind`.** DSH derives pending input from durable user messages and reads `source.kind` on each candidate; a message without a source makes the *next* prompt throw `Cannot read properties of undefined (reading 'kind')` (observed live as `gateway/internal`). Use `buildRewindMessage()`, whose `context-tree-rewind` kind also keeps the event out of the "pending user input" set so the Host never answers it by itself.
- **Repeated rewinds fold the older markers.** Each rewind leaves its own marker on the surface; the next one must shadow those markers too (`cutSeq = min(startSeq, earlierMarkers)`), or every rewind stacks another copy of the same text into the model context.
- **The transcript is rebuilt from the log, not from memory.** Chat renders a row for every appended event and never removes one, so a `replace` leaves the shadowed turns on screen. The Client hides them itself and rebuilds that mask from `cut` on every mount; without it a reload reveals history the model can no longer see.
- **Mask by identity, never by position.** Shadowing is decided from the Host's fold (`rewindMask` → `{ cutSeq, turns, messageIds }`): row turn number, durable message id from the node key, and the plugin's own marker rows. "Everything below this row" is wrong — a user who rewinds and then types keeps that new message visible.
- **Refuse a busy session.** `openTurn()` reports a turn that started and never ended; appending a replacement there races the running request. Return `session-busy` instead of truncating.
- **The mask factory must stay extractable.** `client.js` is loaded as a plain script by the module loader, so it cannot import `src/`. The mask lives in `createRowMask` between the `dc:mask:start` / `dc:mask:end` markers, and `test/mask.test.js` loads that exact slice. Keep it self-contained (no closures over other factory state) or the test stops covering the shipped code.
- **Target messages by durable id.** The Client reads `data.id` back out of the Chat row key (`<kind length>:<kind><id>`, `input-message` for user rows) and the Host matches `String(event.data.id) === messageId` on an append event. Replaced (`surfaceOp: replace`) messages are not targets.
- **No fallback path.** A session the Host does not hold live (`session-not-active`) is reported, never branched. The plugin has no fork route; do not reintroduce one without a user-visible reason.
- **Do not add session event types.** The only write is the replacement `user/message` above; everything else reads through `ctx.sessionQuery` and `ctx.sessions`.
- **Do not override keyed Chat slots.** `conversation.chat.node` keys are owned by Chat (`user`, `turn-tail`, …) and a second registration becomes a dead cell. The message-row icon therefore seats an invisible anchor in the `conversation.chat.user.before` chain and appends a native `<button>` next to the copy button, which Chat renders outside the plugin's tree. Keep that hack contained in one component and remove the node on cleanup.
- **Do not set `sandbox_permissions`** in this environment; approval prompts are disabled.

## Verification

- `npm run check` must pass (syntax + unit tests). Tests use `node:test`; fixtures must follow the real V4 order (`turn/start` first, then the prompt's `user/message`, `surfaceOp` on the event envelope rather than in `data`).
- Live behaviour is only verified by loading the bundle into a DSH profile: click the icon on a second message, confirm the rows and the right-hand turn rail collapse, confirm the text lands in the composer, then reload the page and confirm the mask survives.
- A separate throwaway profile (`dsh --profile <name> --port 0 --no-open`) is the safe way to drive a real GUI without touching the user's window.

## Style

- Plain ES modules, no bundler, no new dependencies.
- Client entry must stay inside `window.__ModuleLoader__.load({ id, factory(require) { … } })` and may only require `react`.
- Theme every colour with `--dsw-alias-*` tokens (with a fallback) and copy through the locale service.
