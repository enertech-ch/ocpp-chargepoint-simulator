// Translate a 2.1 outgoing payload down to 2.0.1 or 1.6 when the negotiated
// subprotocol is older. The strategy is intentionally conservative: strip
// fields the target version doesn't know about, rename a small number of
// well-understood actions, and surface a single per-action warning the UI
// can display once.
//
// This file covers a handful of common actions; extend as needed.

const NEW_IN_21 = new Set([
  // Indicative — extend as the 2.1 schema is integrated.
  'tariffId', 'priority', 'dynamicLimits', 'derProfile', 'allowedEnergyTransfer',
]);

const NEW_IN_201 = new Set([
  // Fields that exist in 2.0.1 (and 2.1) but not 1.6.
  'evse', 'idToken', 'transactionInfo', 'meterValue', 'reservationId',
]);

const ACTION_RENAME_1_6 = {
  // 2.x action name -> 1.6 action name
  'TransactionEvent': null, // no direct 1.6 equivalent — UI should use Start/Stop directly
  'StatusNotification': 'StatusNotification',
  'BootNotification': 'BootNotification',
  'Heartbeat': 'Heartbeat',
  'Authorize': 'Authorize',
  'MeterValues': 'MeterValues',
  'DataTransfer': 'DataTransfer',
  'FirmwareStatusNotification': 'FirmwareStatusNotification',
};

function stripKeys(obj, forbidden) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((x) => stripKeys(x, forbidden));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (forbidden.has(k)) continue;
    out[k] = stripKeys(v, forbidden);
  }
  return out;
}

export function mapPayload({ action, payload, fromVersion = 'ocpp2.1', toVersion }) {
  if (fromVersion === toVersion) return { action, payload, warnings: [] };
  const warnings = [];

  if (toVersion === 'ocpp2.0.1') {
    return {
      action,
      payload: stripKeys(payload, NEW_IN_21),
      warnings: hasAny(payload, NEW_IN_21) ? [`Stripped 2.1-only fields for 2.0.1 target on ${action}`] : [],
    };
  }
  if (toVersion === 'ocpp1.6') {
    const mappedAction = ACTION_RENAME_1_6[action];
    if (mappedAction === null) {
      warnings.push(`Action ${action} has no 1.6 equivalent`);
      return { action, payload, warnings, unsupported: true };
    }
    const stripped = stripKeys(payload, new Set([...NEW_IN_21, ...NEW_IN_201]));
    if (hasAny(payload, NEW_IN_21) || hasAny(payload, NEW_IN_201)) {
      warnings.push(`Stripped 2.x-only fields for 1.6 target on ${action}`);
    }
    return { action: mappedAction || action, payload: stripped, warnings };
  }
  return { action, payload, warnings };
}

function hasAny(obj, set) {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((x) => hasAny(x, set));
  for (const k of Object.keys(obj)) {
    if (set.has(k)) return true;
    if (hasAny(obj[k], set)) return true;
  }
  return false;
}
