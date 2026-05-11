# OCPP ChargePoint Simulator

**▶ [Use the public hosted version](https://enertech-ch.github.io/ocpp-chargepoint-simulator/)** — zero-install OCPP ChargePoint simulator hosted at Github.

A developer-focused OCPP ChargePoint simulator for **OCPP 1.6**, **2.0.1**, and **2.1**.

## Quick start

```bash
npx serve .
# open http://localhost:3000
```

The official OCPP request schemas are already vendored under `schemas/`. To swap or extend them, see [Schema setup](#schema-setup).

## Concept

The UI is built around three primitives:

- **Composer** (centre): pick a Function Block → pick an action → tweak the schema-driven form. The composer publishes its current `{action, version, payload}` to a reactive store.
- **ChargePoints** (right rail): Connections to send the composer's current payload to with a single click (▶). Each CP can carry named parameters that composer fields reference via `{{ cp.params.NAME }}` — these resolve when sending, when running a sequence on the CP, and (as real JS) when recording into a script.
- **Sequences** (right rail): ordered lists of `send` steps with optional delay between. Save the composer's current payload as a step (⇥). Drag the ⠿ handle onto a ChargePoint to run it there.
- **Scripts** (right rail): user-written JavaScript snippets with name / notes / parameters / code. Each script runs in its own Web Worker with a object exposing `send`, `onMessage`, etc. Drag onto a ChargePoint to activate.

The bottom raw-log streams every WebSocket frame in/out, color-coded by ChargePoint.

## Features

- **Multi-connection.** Run many ChargePoints concurrently. Each has its own connection state, OCPP subprotocol, and per-row send/connect/disconnect controls.
- **SharedWorker-backed I/O.** All WebSocket I/O lives in a `SharedWorker`, so the UI never blocks. Multiple browser tabs share the same connections and log.
- **OCPP 1.6 / 2.0.1 / 2.1.** The composer is 2.1-centric. When the target ChargePoint speaks an older protocol, `src/ocpp/backmap.js` strips 2.1- or 2.x-only fields before sending (steps whose action has no equivalent in the target version are silently skipped during sequence runs).
- **Function-Block navigation.** Outgoing CALLs are grouped by the OCPP Function Blocks (A Security … S Battery Swapping), matching the spec.
- **Per-block action list.** Three groups: *Frequently Used*, *Further Messages*, and *Unsupported for Selected Protocols* (greyed out so you can still see they exist).
- **Schema-driven form.** Object → fieldset, enum → `<select>`, string with `pattern`/`format` → text input + 🎲 random, number → bounded numeric + 🎲, boolean → checkbox, array → add/remove rows, `oneOf`/`anyOf` → first branch (extension point for tabs).
- **Random value generation.** Hand-rolled, algorithmic — no value pools. `date-time`, `uuid`, `uri`, `email`, `ipv4`, and arbitrary `pattern` regexes are all generated from scratch and round-trip through Ajv against the source schema (covered by `test/random.test.js` and `test/schemas.test.js`).
- **Sequences.** Persist to IndexedDB. Per-step delay (default 1s for `send`), per-step free-text comment, drag-handle reorder, ⇤ export-step-to-composer / ⇥ import-composer-to-step (locked to same-action to prevent accidents). Drag a sequence onto a ChargePoint to run it.
- **Cross-tab raw log.** Bottom pane, fixed 220px. Filter per ChargePoint, pop out into a standalone window (BroadcastChannel mirrors the stream).
- **ESM-only, no compilation.** Browser loads sources as-is. Runtime deps come from `esm.sh` (Lit, Ajv).

## Schema setup

Drop the official OCPP JSON schema files into the corresponding folder:

```
schemas/
  ocpp1.6/      e.g. BootNotification.json, Authorize.json, …
  ocpp2.0.1/    e.g. BootNotificationRequest.json, …
  ocpp2.1/      e.g. BootNotificationRequest.json, …
```

The schema loader looks for `<Action>Request.json` (2.x) or `<Action>.json` (1.6). Until a schema is present, the form falls back to a free-text JSON editor for that action.

## Architecture

```
 ┌────────────────┐    ┌────────────────┐
 │  Browser tab A │    │  Browser tab B │
 │  (Lit UI)      │    │  (Lit UI)      │
 └────────┬───────┘    └────────┬───────┘
          │ MessagePort         │ MessagePort
          ▼                     ▼
       ┌───────────────────────────────┐
       │       SharedWorker            │
       │  - WebSocket per connection   │
       │  - rolling 5000-frame buffer  │
       │  - BroadcastChannel mirror    │
       └────────────────┬──────────────┘
                        │ ws://
                        ▼
                    OCPP CSMS
```

## Function Block reference

| Block | Name |
| --- | --- |
| A | Security |
| B | Provisioning |
| C | Authorization |
| D | LocalAuthorizationList |
| E | Transactions |
| F | RemoteControl |
| G | Availability |
| H | Reservation |
| I | Tariff and Costs |
| J | Metering |
| K | SmartCharging |
| L | Firmware Management |
| M | Certificate Management |
| N | Diagnostics |
| O | Display Message |
| P | DataTransfer |
| Q | Bidirectional Power Transfer |
| R | DER Control |
| S | Battery Swapping |

Detailed CP-originated action lists are encoded in `src/ocpp/function-blocks.js`.

## Dev

```bash
npm i
npm test
```

Coding Agents should must read [`AGENTS.md`](./AGENTS.md) before anything else.

## Debugging connection failures

When a WebSocket fails, the simulator surfaces what it can — the close code,
a human-readable hint, and `wasClean` and in the CP detail's error banner. 
By spec the JS WebSocket API gives us nothing more.

For the **HTTP-level handshake** (the upgrade request and the server's
response status / headers), open the SharedWorker's DevTools directly —
the page's own Network tab can't see it because the WebSocket is opened
from the worker, not the page:

- **Chromium**: `chrome://inspect` → **Shared workers** → find the entry
  for `connection-worker.js` → click **inspect**. The DevTools window that
  opens has its own Network tab.
- **Firefox**: `about:debugging#/runtime/this-firefox` → scroll to
  **Shared Workers** → "Inspect" next to `connection-worker.js`.

## Connecting to a `ws://` CSMS from an `https://` page

Browsers block insecure WebSocket connections (`ws://`) when the page itself
is loaded over `https://` — "mixed content blocking". There's no JavaScript-
side workaround. If you've deployed the simulator on an HTTPS host but want
to point a ChargePoint at a local `ws://localhost:9000` CSMS, you have three
options:

1. **Serve the simulator over HTTP locally** (recommended for dev). `npx serve .`
   defaults to HTTP. Open `http://localhost:3000` and `ws://` works.
2. **Use a `wss://` CSMS endpoint** (proper TLS).
3. **Allow insecure content for the site** in your browser's site settings
   (Chrome: lock icon → Site Settings → Insecure content → Allow).

The CP detail view shows an inline warning when it detects a mixed-content
URL so you're not staring at an opaque WebSocket failure.

## Compatibility

Chromium and Firefox: full support. Safari 16+: SharedWorker works. Older browsers fall back to a dedicated worker (no cross-tab log sharing).

## Licence

[AGPL-3.0](LICENSE)

This is free community software: it is prohibited to sell this tool as a private product or hide its source code. Under the AGPL license, any modifications or hosted versions must remain open-source and free for everyone to use and improve.