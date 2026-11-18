# Agent notes — dk-dsh-context-tree

## Shape

- Two halves in one bundle: Host `index.js` (three `connection.fetch` routes — `preview` plans the optional file revert, `truncate` performs the rewind, `cut` is read-only) and Client `client.js` (module loader entry, one slot).
- `src/plan.js` and `src/files.js` are pure and unit-tested; keep them free of Cordis, Session Store and DOM so both halves can be reasoned about in isolation.

## Invariants

- **One model-invisible marker.** Replace only the positional live suffix from the chosen prompt, using the exact surface nodes as `sourceEventSeqs`. An empty `developer/message` at the real target turn/step projects to no model message in DSH. Never copy the draft into a marker, emit a pending user input, or extend the range back to an older marker. Stored events stay append-only.
- **The transcript is rebuilt from the log, not from memory.** Chat renders a row for every appended event and never removes one, so a `replace` leaves the shadowed turns on screen. The Client hides them itself and rebuilds that mask from `cut` on every mount; without it a reload reveals history the model can no longer see.
- **Only this plugin's markers define a cut.** Recognize current empty developer markers and historical user markers from `context-tree-rewind`. Ordinary system replacements, compaction and replay do not themselves mark a rewind.
- **Mask by identity, never by position.** Shadowing is decided from the Host's fold (`rewindMask` → `{ cutSeq, turns, messageIds, retainedRowKeys? }`): row turn number, durable message id from the node key, and the plugin's own marker rows. Preserve retained pre-prompt context cards and their containers even inside a masked turn. "Everything below this row" is wrong — a user who rewinds and then types keeps that new message visible.
- **The mask is per session.** The mask is a module-level singleton but turn numbers restart at 1 in every session. `restoreMask` must clear it when `sessionId` changes, fetch that session's cut, and ignore an in-flight result once another session is active; otherwise a cut in session A hides rows with the same turn number in session B. Switching back re-reads the cut instead of trusting the other session's mask.
- **Refuse a busy session.** `openTurn()` reports a turn that started and never ended; appending a replacement there races the running request. Return `session-busy` instead of truncating.
- **The mask factory must stay extractable.** `client.js` is loaded as a plain script by the module loader, so it cannot import `src/`. The mask lives in `createRowMask` between the `dc:mask:start` / `dc:mask:end` markers, and `test/mask.test.js` loads that exact slice. Keep it self-contained (no closures over other factory state) or the test stops covering the shipped code.
- **Target messages by durable id.** The Client reads `data.id` back out of the Chat row key (`<kind length>:<kind><id>`, `input-message` for user rows) and the Host matches `String(event.data.id) === messageId` on an append event. Replaced (`surfaceOp: replace`) messages are not targets.
- **No fallback path.** A session the Host does not hold live (`session-not-active`) is reported, never branched. The plugin has no fork route; do not reintroduce one without a user-visible reason.
- **No new event types or snapshot store.** Plan only from existing log evidence. `meta.diffs` is for display, not a reversible byte patch. Never write to an existing file based only on a unique text match. Missing provenance or old bytes is `unproven`, not success.
- **Bind confirmation to preview.** The preview is read-only. Signing uses the session/target/revision/ordered cut and, for file opt-in, the checked file plans and versions. Check the live revision immediately before append with no intervening await. No implicit confirm, retry or scope expansion. The dialog's file option is off by default.
- **Durability gates file work.** Append before flushing; on throw or no durability listener, report `flush-failed` and never touch files. Use only the confirmed file plan and report per-file results. The marker is already in memory, so do not retry the append.
- **Never bypass the active FS provider.** Use the session sandbox policy and a provider version guard on every mutation. Guarded `ctx.fs.deleteFile` is available in rc.3; without it, deletion is unsupported. Do not use raw Host path operations. Refuse unproven content, changed targets, and unsupported backends.
- **The dialog stays dependency-free.** It is a native `<dialog>` built with the DOM API, styling through `--dsw-alias-*` tokens. This keeps `client.js` on its single `react` require.
- **Do not override keyed Chat slots.** `conversation.chat.node` keys are owned by Chat (`user`, `turn-tail`, …) and a second registration becomes a dead cell. The message-row icon therefore seats an invisible anchor in the `conversation.chat.user.before` chain and appends a native `<button>` next to the copy button, which Chat renders outside the plugin's tree. Keep that hack contained in one component and remove the node on cleanup.
- **Do not set `sandbox_permissions`** in this environment; approval prompts are disabled.

## Verification

- `npm run check` must pass (syntax + unit tests). Tests use `node:test`; fixtures must follow the real V4 order (`turn/start`, `step/start`, then the prompt's `user/message`, `surfaceOp` on the event envelope rather than in `data`). File-revert tests stub `ctx.fs` and `ctx.sandboxPolicy` and assert the provider receives a version guard and current policy, including a post-confirm concurrent edit.
- Live behaviour is only verified by loading the bundle into a DSH profile: click the icon on a second message, confirm the rows and the right-hand turn rail collapse, confirm the text lands in the composer, then reload the page and confirm the mask survives. For the file dialog, make a write/edit after a message, rewind to it, check the file list and View Diff, then confirm with the checkbox on and off.
- A separate throwaway profile (`dsh --profile <name> --port 0 --no-open`) is the safe way to drive a real GUI without touching the user's window.

## Release

- 提交推送前按 [docs/agents/push-rules.md](<docs/agents/push-rules.md>) 默认升修订号；用户明确指定版本或要求不升时除外。

## Style

- Plain ES modules, no bundler, no new dependencies.
- Client entry must stay inside `window.__ModuleLoader__.load({ id, factory(require) { … } })` and may only require `react`.
- Theme every colour with `--dsw-alias-*` tokens (with a fallback) and copy through the locale service.
