import './ui/ocpp-app.js';
import { connections } from './state/connections.js';

// Initialize the SharedWorker connection so the UI is wired up before any
// component asks for connection state. Falls back to a DedicatedWorker if
// the browser doesn't support SharedWorker (single-tab mode).
//
// Built-in scripts (e.g. SetVariables handler) are seeded lazily on the
// first listScripts() call — see ensureBuiltinsOnce in src/lib/scripts.js.
// Driving the seeder from here too would race that call and produce
// duplicates.
connections.init();
