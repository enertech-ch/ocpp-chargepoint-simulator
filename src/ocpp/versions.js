export const VERSIONS = ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'];
export const DEFAULT_VERSION = VERSIONS[VERSIONS.length - 1];

// Pick the highest version (newest) from the provided iterable that's also in
// VERSIONS. Falls back to DEFAULT_VERSION when the iterable is empty/missing.
export function highestVersion(selected) {
  if (!selected) return DEFAULT_VERSION;
  const set = selected instanceof Set ? selected : new Set(selected);
  for (let i = VERSIONS.length - 1; i >= 0; i--) {
    if (set.has(VERSIONS[i])) return VERSIONS[i];
  }
  return DEFAULT_VERSION;
}

export const VERSION_LABEL = {
  'ocpp1.6': 'OCPP 1.6',
  'ocpp2.0.1': 'OCPP 2.0.1',
  'ocpp2.1': 'OCPP 2.1',
};

export function schemaFilename(version, action) {
  return version === 'ocpp1.6' ? `${action}.json` : `${action}Request.json`;
}

// Many OCPP 2.0.1 servers in the wild advertise the older draft subprotocol
// string `ocpp2.0` during the WebSocket upgrade instead of the canonical
// `ocpp2.0.1`. Offering both lets the handshake succeed against either —
// the browser picks whichever the server returns. Compliant servers pick
// the first entry; we list the canonical name first so it wins when both
// are supported.
const SUBPROTOCOL_ALTERNATES = {
  'ocpp2.0.1': ['ocpp2.0.1', 'ocpp2.0'],
};

export function subprotocolsFor(version) {
  return SUBPROTOCOL_ALTERNATES[version] || [version];
}
