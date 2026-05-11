// Reactive snapshot of what the user is currently editing in the composer.
// The form writes here as the user types/randomizes; other components
// (notably workbench-panel for "+ Add step to sequence") read from here.
//
// Shape:
//   {
//     action: 'BootNotification' | null,
//     version: 'ocpp2.1',
//     payload: {…},
//     valid: boolean,        // last Ajv result, or null if no schema present
//   }

import { createStore } from './store.js';

export const composer = createStore({
  action: null,
  version: 'ocpp2.1',
  payload: {},
  valid: null,
});
