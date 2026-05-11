// OCPP Function Block registry (Edition 2, 2025-12-03). Each entry maps a
// block letter to its human name and the OCPP actions a ChargePoint can
// originate (CP → CSMS calls). `versions` lists which protocol versions
// natively support that action; back-mapping from 2.1 to older versions
// lives in ./backmap.js.

const V_ALL = ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'];
const V_2x  = ['ocpp2.0.1', 'ocpp2.1'];
const V_21  = ['ocpp2.1'];
const V_16  = ['ocpp1.6'];

export const FUNCTION_BLOCKS = [
  {
    letter: 'A', name: 'Security',
    actions: [
      { action: 'SecurityEventNotification', versions: V_2x },
      { action: 'SignCertificate', versions: V_2x },
    ],
  },
  {
    letter: 'B', name: 'Provisioning',
    actions: [
      { action: 'BootNotification', versions: V_ALL },
      { action: 'Heartbeat', versions: V_ALL },
      { action: 'NotifyReport', versions: V_2x },
      { action: 'FirmwareStatusNotification', versions: V_ALL },
      { action: 'PublishFirmwareStatusNotification', versions: V_2x },
    ],
  },
  {
    letter: 'C', name: 'Authorization',
    actions: [
      { action: 'Authorize', versions: V_ALL },
      { action: 'NotifySettlement', versions: V_21 },
      { action: 'NotifyWebPaymentStarted', versions: V_21 },
      { action: 'VatNumberValidation', versions: V_21 },
    ],
  },
  {
    letter: 'D', name: 'LocalAuthorizationList',
    actions: [],
  },
  {
    letter: 'E', name: 'Transactions',
    actions: [
      { action: 'TransactionEvent', versions: V_2x },
      { action: 'StartTransaction', versions: V_16 },
      { action: 'StopTransaction', versions: V_16 },
    ],
  },
  {
    letter: 'F', name: 'RemoteControl',
    actions: [],
  },
  {
    letter: 'G', name: 'Availability',
    actions: [
      { action: 'StatusNotification', versions: V_ALL },
      { action: 'Heartbeat', versions: V_ALL },
    ],
  },
  {
    letter: 'H', name: 'Reservation',
    actions: [
      { action: 'ReservationStatusUpdate', versions: V_2x },
    ],
  },
  {
    letter: 'I', name: 'Tariff and Costs',
    actions: [
      { action: 'NotifySettlement', versions: V_21 },
    ],
  },
  {
    letter: 'J', name: 'Metering',
    actions: [
      { action: 'MeterValues', versions: V_ALL },
    ],
  },
  {
    letter: 'K', name: 'SmartCharging',
    actions: [
      { action: 'NotifyChargingLimit', versions: V_2x },
      { action: 'ClearedChargingLimit', versions: V_2x },
      { action: 'NotifyEVChargingNeeds', versions: V_2x },
      { action: 'NotifyEVChargingSchedule', versions: V_2x },
      { action: 'ReportChargingProfiles', versions: V_2x },
      { action: 'NotifyPriorityCharging', versions: V_21 },
      { action: 'PullDynamicScheduleUpdate', versions: V_21 },
    ],
  },
  {
    letter: 'L', name: 'Firmware Management',
    actions: [
      { action: 'FirmwareStatusNotification', versions: V_ALL },
      { action: 'PublishFirmwareStatusNotification', versions: V_2x },
      { action: 'DiagnosticsStatusNotification', versions: V_16 },
    ],
  },
  {
    letter: 'M', name: 'Certificate Management',
    actions: [
      { action: 'SignCertificate', versions: V_2x },
      { action: 'Get15118EVCertificate', versions: V_2x },
      { action: 'GetCertificateStatus', versions: V_2x },
      { action: 'GetCertificateChainStatus', versions: V_21 },
    ],
  },
  {
    letter: 'N', name: 'Diagnostics',
    actions: [
      { action: 'LogStatusNotification', versions: V_2x },
      { action: 'NotifyEvent', versions: V_2x },
      { action: 'NotifyMonitoringReport', versions: V_2x },
      { action: 'NotifyCustomerInformation', versions: V_2x },
      { action: 'NotifyPeriodicEventStream', versions: V_21 },
    ],
  },
  {
    letter: 'O', name: 'Display Message',
    actions: [
      { action: 'NotifyDisplayMessages', versions: V_2x },
    ],
  },
  {
    letter: 'P', name: 'DataTransfer',
    actions: [
      { action: 'DataTransfer', versions: V_ALL },
    ],
  },
  {
    letter: 'Q', name: 'Bidirectional Power Transfer',
    actions: [
      { action: 'NotifyAllowedEnergyTransfer', versions: V_21 },
    ],
  },
  {
    letter: 'R', name: 'DER Control',
    actions: [
      { action: 'NotifyDERAlarm', versions: V_21 },
      { action: 'NotifyDERStartStop', versions: V_21 },
      { action: 'ReportDERControl', versions: V_21 },
    ],
  },
  {
    letter: 'S', name: 'Battery Swapping',
    actions: [
      { action: 'BatterySwap', versions: V_21 },
      { action: 'RequestBatterySwap', versions: V_21 },
    ],
  },
];

// Convenience lookup: { 'BootNotification': { block: 'B', versions: [...] } }
// When the same action appears in multiple blocks (e.g. Heartbeat in B & G),
// the *first* block wins for the index. Lookups by block are done directly
// against FUNCTION_BLOCKS.
export const ACTION_INDEX = (() => {
  const out = {};
  for (const block of FUNCTION_BLOCKS) {
    for (const a of block.actions) {
      if (!out[a.action]) {
        out[a.action] = { block: block.letter, blockName: block.name, versions: a.versions };
      }
    }
  }
  return out;
})();
