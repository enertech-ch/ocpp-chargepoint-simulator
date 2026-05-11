# AGENTS.md

A walkthrough of this codebase for future contributors.
The README is the user-facing intro; this file is the engineering map.

## Stack

- **Lit 3** web components, loaded from `esm.sh` (no bundler).
- **Ajv 8** for schema validation (also from `esm.sh` in the browser, npm in tests).
- **SharedWorker** hosts every WebSocket; UI tabs are dumb clients over `MessagePort`.
- **IndexedDB** stores sequences and scripts. **localStorage** stores UI prefs (ChargePoints, hidden-log filter, action-version filter).
- **Vitest + fake-indexeddb** for tests. No bundler, no transpiler — pure ESM.

## Layout

```
index.html, log.html         shells (log.html is the pop-out)
src/main.js                  bootstraps <ocpp-app> + connections.init()
src/state/
  store.js                   minimal createStore() pub/sub
  composer.js                reactive snapshot of the form: {action, version, payload}
  connections.js             tab-side connection registry; talks to worker
  active-runs.js             per-CP in-memory registry of running sequences + scripts
  persistence.js             localStorage facade (ocpp-sim:* namespace)
src/workers/
  protocol.js                shared message-type enum (C2W, W2C, ConnState)
  connection-worker.js       SharedWorker: WebSockets, log ring, BroadcastChannel
  script-runner.js           one dedicated Worker per active user script
src/ocpp/
  versions.js                VERSIONS + schemaFilename(version, action)
  function-blocks.js         A..S blocks → action lists + ACTION_INDEX lookup
  frequent-actions.js        curated 1-6 actions per block (drive the "Frequently used" group)
  schema-loader.js           lazy fetch of /schemas/<version>/<file>.json, in-memory cache
  backmap.js                 2.1 → 2.0.1 / 1.6 field stripping + action rename
src/lib/
  ajv.js                     shared Ajv instance + normalize($schema, id → $id, multipleOfPrecision:6)
  random.js                  schema-driven random value generators (incl. regex walker)
  idb.js                     IndexedDB wrapper. DB ocpp-sim v1, stores: sequences, scripts
  workbench-io.js            export / import: buildExport, parseImport, downloadJson
  sequences.js               sequence CRUD + runSequence() runner
  scripts.js                 script CRUD (the runtime lives in active-runs + the Worker)
  templates.js               {{ expr }} resolver + JS source emitter for recordings
  labels.js                  nextLabel('Foo', items) / copyName(item, items) helpers
src/ui/
  lit.js                     re-export of Lit from esm.sh (single point of pinning)
  styles.css                 global tokens (CSS custom props) + ocpp-app grid
  shared-styles.js           formStyles CSSResult included by every shadow-DOM component
  connection-hue.js          per-CP hue helpers (pickHue/hueOf/bgFor/fgFor + hex↔hue conversions for the slider)
  ocpp-app.js                top-level grid component (topbar, blocks, actions, message, bench, log)
  function-block-nav.js      A..S block selector
  action-list.js             three groups: Frequently used / Further / Unsupported
  message-form.js            schema-driven composer body
  workbench-panel.js         right-rail master/detail for CPs + sequences + scripts
  raw-log.js                 bottom log pane (also rendered standalone in log.html)
test/
  *.test.js                  see "Tests" below
schemas/<version>/           vendored official OCPP request schemas
```

## Data flow

1. The user picks a block in `function-block-nav` → `block-change` event → `ocpp-app` sets `_block`.
2. The user picks an action in `action-list` → `edit-action` event → `ocpp-app` sets `_action`.
3. `<message-form>` loads the schema (cached via `schema-loader`), generates a random payload (or applies `initialPayload`), and writes the result into the `composer` store.
4. `<workbench-panel>` reads the composer store on every change and uses it to:
   - enable ▶ on each ChargePoint row (send),
   - enable ⏺ on each sequence row (append step),
   - decide whether ⇥ (import composer → step) is allowed (same-action only).
5. Send goes `composer → connections.send(id, action, payload) → port.postMessage(C2W.Send) → worker → WebSocket`. The worker pushes a log frame which fans out to every connected tab via `broadcastToClients` and a `BroadcastChannel` mirror for `log.html`.

## Domain naming

These names are deliberate — don't drift back.

| Layer | Internal handle | User-facing identity | URL | Version | Description text |
| --- | --- | --- | --- | --- | --- |
| ChargePoint | `key` (`c<random>`) | `id` (e.g. `CP_001`) | `csmUrl` (CentralSystem URL, supports `{{ cp.id }}` templating, resolved at connect time) | `ocppVersion` | `description` |
| Sequence | `id` (IDB PK) | `label` | — | — | `description` |
| Script | `id` (IDB PK) | `label` | — | — | `description` |

`{{ cp.id }}` inside a CP's `csmUrl` is run through `resolveTemplates(url, cpScope(cp))` in `connections.connect()` just before the URL is handed to the SharedWorker. The wire protocol between tab and worker still uses `id`/`url`/`subprotocol` field names — `connections.js` is the translation layer.

When you grep for `cp.id` in JS, you're asking for the **user-facing OCPP identifier**, not the routing handle. Routing is always `cp.key` / `connections.connect(key)` / `connections.send(key, ...)` / `frame.connId === cp.key` (the worker's `connId` is the key).

## Critical conventions

- **No class-based selection state.** The composer is the single source of truth for "what message is being edited". Rows show the action name; clicking a row loads it into the composer. There is no "selected message" concept beyond `composer.action`.
- **Names are gap-filled.** `labels.nextLabel('ChargePoint', items, 'label')` finds the smallest unused `#N`. Duplication uses `labels.copyName(source, items, 'label')` → `<base> (copy)` / `(copy 2)` / …, where the new name must differ from *every* item including the source. Same util is used for CPs, sequences, and scripts.
- **Light-DOM CSS does NOT cascade into `:host` rules.** `styles.css` only sets `height: 100vh` on `ocpp-app` — no `display:` or layout properties, because light-DOM rules outrank `:host { display: grid }` per the CSS Scoping spec. Layout lives entirely inside `ocpp-app.static styles`.
- **Sequence step rows: don't mutate during render.** Workbench-panel renders defensive `if (!seq) { queueMicrotask(() => this._back()); return html\`\`; }` — never call state-mutating methods inline during a render pass. Deletions navigate back BEFORE the IDB delete + reload, so the detail view never tries to render a vanishing record.
- **Drag MIME types are namespaced.** Sequence drag uses `application/x-ocpp-sequence`; step reorder uses `application/x-ocpp-step`. Listed as `WorkbenchPanel.DRAG_MIME` / `STEP_DRAG_MIME` on the class.
- **`$schema` is stripped, `id` is promoted to `$id`.** Ajv 8 doesn't ship draft-04 / draft-06 metas; OCPP 1.6 / 2.0.1 are draft-04 and 2.1 is draft-06. The differences for the keywords OCPP uses are nil, so `ajv.normalize()` removes the meta hint. Also: `multipleOfPrecision: 6` is required — `82.3 / 0.1 ≠ 823` in IEEE-754.
- **Random generator respects `maxLength` over `minLength`.** ISO 4217 currency codes have `maxLength: 3`. If the random string min defaults > max, you'll get silent schema failures. See `randomString_` in `src/lib/random.js`.
- **`customData` is skipped.** OCPP 2.x extension slot; both the random generator and the form skip it unless it's `required`.

## Activation: sequences and scripts on ChargePoints

Sequences and scripts are *defined* once (persisted in IDB) and *activated* on
a specific CP at runtime by drag-dropping their ⠿ handle onto a CP row. The
`active-runs.js` registry holds one entry per activation, keyed by an
in-session run id; refresh wipes it.

Lifecycle (both kinds):

- `running` → user clicks ■ (stop) **or** the script calls `script.stop()` **or**
  a sequence reaches its end → `stopped`.
- A stopped entry stays in the CP's "Active" list until the user clicks ✕.
  EXCEPTION: sequences that complete naturally auto-remove (per the original
  spec — "Sequences get cleared automatically"). Scripts always stay so the
  user can see they ran.
- The registry emits a `tick({ cpId, kind })` on every step start/success and
  every `cp.sendMessage` / incoming-frame routing. The UI uses this to flash the
  per-CP counter chip for 400ms.

### Script runtime API

User code is wrapped in `new AsyncFunction('cp', 'script', code)` inside a
dedicated Web Worker (one per activation). Two args, split by concern:

`cp` — the host ChargePoint:

| Member | Description |
| --- | --- |
| `cp.id`, `cp.label`, `cp.ocppVersion` | Identity of the host ChargePoint. `cp.id` is the OCPP-level identifier the user set in the CP detail form. |
| `cp.state` | Current connection state: `'idle' \| 'connecting' \| 'open' \| 'closing' \| 'closed' \| 'error'`. Updated by the main thread on every transition. |
| `cp.connect()` / `cp.disconnect()` | Trigger the host CP's WebSocket lifecycle from inside a script — same effect as the ⏻ toggle on the CP row. |
| `cp.onConnect(handler)` | Fires on every transition INTO the `'open'` state. Re-fires after reconnect. Returns an unsubscribe fn. |
| `cp.onDisconnect(handler)` | Fires on every transition OUT of `'open'`. Handler receives the optional error string. Returns an unsubscribe fn. |
| `cp.params.<name>` | The CP's own params (a `{name: value}` map, parsed from JSON where possible). Mirrors what `{{ cp.params.X }}` resolves to. |
| `cp.sendMessage(action, payload)` | CALL to the CSMS over the host CP's WebSocket; resolves with the CALLRESULT payload, rejects with CALLERROR `{code, description, details}` or `Error('stopped')`. |
| `cp.onMessage((payload, response) => …)` | **Global** handler — runs for every CSMS-initiated CALL on this CP. `response` is a plain object (starts `{}`); mutate fields directly (`response.foo = …`) or return a new object to replace it. The same object threads through every handler in the per-CP chain in registration order. |
| `cp.onMessage('Action', (payload, response) => …)` | **Action-filtered** handler — same shape; the orchestrator skips this handler when the CALL's action doesn't match. |
| `cp.waitForMessage(action, { timeout? })` | One-shot await: resolves with the next CALL frame whose action matches. Default timeout 30s. Rejects with `Error('timeout …')` or `Error('stopped')`. |

`script` — this run:

| Member | Description |
| --- | --- |
| `script.params.<name>` | String values from the script's `params` config. Coerce to numbers yourself. |
| `script.log(...args)` | Routed to `console.log` on the main thread, prefixed with the script name. |
| `script.sleep(ms)` | Resolves after `ms`. Rejects with `Error('stopped')` if aborted. |
| `script.stop()` | Halts execution. Equivalent to the user clicking ■ on the active entry. |
| `script.signal` | `AbortSignal` you can pass to `fetch`, etc. — aborts when the run is stopped. |

The worker has no direct WebSocket or DOM access — all I/O goes through the
postMessage bridge in `active-runs.activateScript`. See
`src/workers/script-runner.js` for the wire protocol.

### CP params + `{{ expr }}` templates

Each ChargePoint owns a `params: [{name, value}]` array (edited from the CP
detail view). Values are JSON-parsed if possible, otherwise stored as plain
strings — so `42` becomes a number, `{"a":1}` an object, and `X1` a string.

Anywhere a string in a composer payload (or the CP's `csmUrl`) contains
`{{ ... }}`, the contents are a JavaScript expression with one argument in
scope: `cp`, built by `cpScope(cp)` to expose `cp.id`, `cp.label`,
`cp.ocppVersion`, and `cp.params` (a `{name: value}` map).

Two shapes, both implemented in `src/lib/templates.js`:

- **Whole-string** `"{{ cp.params.bootNotification }}"` — the value is *replaced* with the raw expression result. An object param splats in as an object, not a stringified blob.
- **Inline** `"prefix-{{ cp.params.model }}!"` — the result is coerced to a string and concatenated.

`undefined` is the standard "missing" outcome — write `?? 'fallback'` for
defaults. Expressions that throw also resolve to `undefined`.

Four consumers:

| Caller | What it does |
| --- | --- |
| `connections.connect(key)` | Resolves the CP's `csmUrl` via `resolveTemplates(url, cpScope(cp))` before handing it to the SharedWorker. |
| `▶` on a CP row (`_sendToCp`) | Calls `resolveTemplates(payload, cpScope(cp))` before `connections.send`. |
| `runSequence` | Same, per `send` step, using the target CP's full scope. |
| `_appendToScript` (recording) | Uses `toScriptSource(payload)` instead of `JSON.stringify`. Whole-string templates emit as bare expressions `(cp.params.x)`; inline templates become template literals `` `pre-${cp.params.x}-post` ``. The script's `cp` object exposes the same shape so the recorded code resolves at runtime in the worker. |

### CSMS→CP CALLs: per-CP handler chain (orchestrated in `active-runs`)

`cp.onMessage` is scoped to the ChargePoint, not the script. Every active
script's handlers are appended to ONE shared chain per CP, owned and
walked by `active-runs.js` on the main thread. The SharedWorker has no
auto-ack and no knowledge of handlers — it just forwards incoming frames
through the log subscription and sends one Respond per CALL.

Flow on an incoming CSMS-initiated CALL:

1. `active-runs._dispatchCall(cpKey, frame)` looks up the per-CP chain.
2. `response = {}`.
3. For each `{ entry, handlerId, filterAction }` in registration order:
   - If `filterAction` is set and doesn't match → skip.
   - Else postMessage `{ type: 'invoke', invocationId, handlerId, payload, response }` to the entry's Worker. Await `{ type: 'invoke-result', ok, response | error }`.
4. After the loop, `connections.respond(cpKey, messageId, response)` (or
   `respondError` if any handler threw). Exactly one frame on the wire.

This means **no duplicates regardless of how many scripts are active on a
CP** — the chain is per-CP, not per-script.

If no script is active on a CP, CSMS-initiated CALLs go unanswered. That's
by design — keep at least one responder script on each connected CP.

In the script Worker, `cp.onMessage` is a thin proxy: it stores the handler
function locally in a `Map<handlerId, fn>` and posts `register-handler`
with `{ handlerId, filterAction? }` to the orchestrator. On invocation,
the worker looks up the handler, calls it with `(payload, response)`,
and posts back the (possibly mutated) response. Mutate fields directly
(`response.foo = …`) or return a new object to replace it. For nested
objects, `script.merge(target, source)` recursively merges.

The built-in **"Handle SetVariables (built-in)"** script ships with the app
(seeded by `ensureBuiltinScripts()` at boot). It exposes six param buckets
(`accepted`, `rejected`, `unknownComponent`, `unknownVariable`,
`notSupportedAttrType`, `rebootRequired`); unlisted variables default to
`Rejected`. Drag onto a CP like any other script. See `src/lib/scripts.js`
for the canonical code.

### Drag MIME types

- `application/x-ocpp-sequence` — sequence-to-CP drop
- `application/x-ocpp-script` — script-to-CP drop
- `application/x-ocpp-step` — step reorder inside a sequence

`_dragHasActivatable(ev)` accepts either of the first two.

## Tests

Run all: `npm test`. Notable suites:

- `schemas.test.js` walks every vendored schema (currently 182) and asserts that `randomFromSchema(schema)` produces a value that `compile(schema)` accepts.
- `sequences.test.js` mocks `connections` and exercises the runner: order, stopOnError true/false, version-skip, per-step `delaySeconds`, abort mid-pause.
- `random.test.js` covers each format + 1000-sample `pattern` round-trips.
- `backmap.test.js` covers the 2.1 → 2.0.1 / 1.6 strip + rename.
- `persistence.test.js` round-trips a sequence through `fake-indexeddb`.
- `scripts.test.js` covers script CRUD, the default-code hints, and that `ensureBuiltinScripts()` seeds each built-in (`handle-set-variables`, `default-cp-behavior`, `charging-simulation`) idempotently.
- `templates.test.js` covers `{{ … }}` resolution, `cpScope`, and `toScriptSource`.
- `workbench-io.test.js` covers export (sorted, transient-stripped) and import (parses + tolerates missing sections).

There are intentionally no Vitest tests for `active-runs` or `script-runner.js`:
both depend on the browser's `Worker` constructor and on `connections.send`
backed by a real WebSocket, neither of which are trivial to fake. Smoke-test
manually in the browser.

## Gotchas / past bugs to remember

- **Light DOM CSS broke the grid twice.** Don't add `display:` rules for the `ocpp-app` selector in `styles.css`.
- **`display: contents` wrappers break the grid.** Don't wrap component children in containers for event binding — use `addEventListener` on the host in `connectedCallback`.
- **Scroll-to-bottom needs `await this._reloadSequences()`.** Forgot the await once; `updateComplete` then saw stale state. If you add similar UI logic, await the reload before `await this.updateComplete`.
- **`it !== source` was the wrong exclusion in `copyName`.** Source must be considered in the collision check — the duplicate must differ from every item, including the source.
- **The detail view can be rendered after its record is deleted.** Always navigate back BEFORE the IDB delete; the `queueMicrotask(() => this._back())` in the render path is the safety net, not the primary mechanism.

## Where to extend

- New OCPP versions: extend `VERSIONS` in `versions.js`, add a schema folder, and wire the version into `function-blocks.js` for new actions.
- New action: add it to a block in `function-blocks.js` and (optionally) `frequent-actions.js`. Drop the schema in `schemas/<version>/`. No other registration needed — `ACTION_INDEX` is derived.
- New step kind beyond `send`/`pause`: extend the `runSequence` switch in `src/lib/sequences.js` and add a render branch in `_renderStep` in `workbench-panel.js`.
- New persistent store: add a key to `SCHEMA` in `src/lib/idb.js` and bump `DB_VERSION` — the `onupgradeneeded` handler will create the new store on next open. There's no in-place migration path; the simulator is dev tooling and we let users start clean across DB versions.
- New built-in script: add a `{ builtinId, label, description, params, code }` entry to `BUILTINS` in `src/lib/scripts.js`. The seeder will create it on next `listScripts()`. Bump tests in `scripts.test.js`.
