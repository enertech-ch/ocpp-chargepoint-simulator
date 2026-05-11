// Per Function Block: the actions a developer reaches for most often. Shown
// at the top of the action list under "Frequently Used Actions"; the rest of
// the block's actions follow under "Further Actions". Opinionated, not
// exhaustive.

export const FREQUENT_ACTIONS = {
  A: ['SecurityEventNotification', 'SignCertificate'],
  B: ['BootNotification', 'Heartbeat', 'NotifyReport', 'FirmwareStatusNotification'],
  C: ['Authorize'],
  D: [],
  E: ['TransactionEvent', 'StartTransaction', 'StopTransaction'],
  F: [],
  G: ['StatusNotification', 'Heartbeat'],
  H: ['ReservationStatusUpdate'],
  I: ['NotifySettlement'],
  J: ['MeterValues'],
  K: ['NotifyChargingLimit', 'NotifyEVChargingNeeds', 'ReportChargingProfiles', 'NotifyEVChargingSchedule'],
  L: ['FirmwareStatusNotification', 'DiagnosticsStatusNotification'],
  M: ['SignCertificate', 'Get15118EVCertificate'],
  N: ['LogStatusNotification', 'NotifyEvent', 'NotifyMonitoringReport', 'NotifyCustomerInformation'],
  O: ['NotifyDisplayMessages'],
  P: ['DataTransfer'],
  Q: ['NotifyAllowedEnergyTransfer'],
  R: ['NotifyDERAlarm', 'NotifyDERStartStop'],
  S: ['BatterySwap', 'RequestBatterySwap'],
};
