// Tab ↔ SharedWorker message envelope. Imported by both sides so the
// contract stays in one place. Plain JSON-serializable objects only.

export const LOG_CHANNEL = 'ocpp-log';
export const LOG_RING_SIZE = 5000;

// Client → Worker
export const C2W = {
  Hello: 'hello',
  Connect: 'connect',
  Disconnect: 'disconnect',
  Send: 'send',
  Hydrate: 'hydrate',
  // Send a CALLRESULT/CALLERROR for a CSMS-initiated CALL the script handled.
  Respond: 'respond',
  // Inject a log entry from the main thread (e.g. script.log) so it shares
  // the ring buffer + broadcast path with WebSocket frames.
  PushLog: 'push-log',
};

// Worker → Client
export const W2C = {
  Hello: 'hello',
  ConnectionState: 'connection-state',
  Log: 'log',
  Hydrate: 'hydrate',
  SendResult: 'send-result',
};

// Connection lifecycle states surfaced to the UI.
export const ConnState = {
  Idle: 'idle',
  Connecting: 'connecting',
  Open: 'open',
  Closing: 'closing',
  Closed: 'closed',
  Error: 'error',
};
