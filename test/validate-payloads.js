#!/usr/bin/env node
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const schemas16 = require('ocpp-rpc/lib/schemas/ocpp1_6.json');
const schemas201 = require('ocpp-rpc/lib/schemas/ocpp2_0_1.json');
const schemas21 = require('ocpp-rpc/lib/schemas/ocpp2_1.json');
const P = require('../src/payloads');

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const key = (version, action) => `${version}/${action}.req`;
// 1.6 / 2.0.1 use `urn:Foo.req`; 2.1 uses `urn:FooRequest`.
const ACTION_PATTERNS = [/^urn:(.+)\.req$/, /^urn:(.+)Request$/];
function register(version, schemas) {
    for (const s of schemas) {
        const id = s.$id || '';
        const m = ACTION_PATTERNS.map((re) => re.exec(id)).find(Boolean);
        if (!m) continue;
        const { $id, ...rest } = s;
        ajv.addSchema(rest, key(version, m[1]));
    }
}
register('1.6', schemas16);
register('2.0.1', schemas201);
register('2.1', schemas21);

const TS = '2026-05-11T12:00:00.000Z';
const TX_ID_16 = 42;
const TX_ID_201 = 'a8a3b8e6-1d6c-4f3f-9c6a-1b6e0e5d8a1a';
const ID_TAG = 'DEADBEEF';
const MV = 100;
const BOOT = { vendor: 'TestVendor', model: 'TestModel', serialNumber: '123456789', firmwareVersion: '1.0.0' };

const cases = [
    ['1.6',   'BootNotification',   P.bootNotification('ocpp1.6', BOOT)],
    ['1.6',   'Heartbeat',          P.heartbeat()],
    ['1.6',   'StatusNotification', P.statusNotification('ocpp1.6', { status: 'Available', timestamp: TS })],
    ['1.6',   'StatusNotification', P.statusNotification('ocpp1.6', { status: 'Occupied',  timestamp: TS })],
    ['1.6',   'Authorize',          P.authorize('ocpp1.6', { idTag: ID_TAG })],
    ['1.6',   'StartTransaction',   P.startTransaction16({ idTag: ID_TAG, timestamp: TS, meterStart: 0 })],
    ['1.6',   'StopTransaction',    P.stopTransaction16({ transactionId: TX_ID_16, meterStop: MV, timestamp: TS })],
    ['1.6',   'MeterValues',        P.meterValues16({ transactionId: TX_ID_16, timestamp: TS, meterValue: MV })],

    ['2.0.1', 'BootNotification',   P.bootNotification('ocpp2.0.1', BOOT)],
    ['2.0.1', 'Heartbeat',          P.heartbeat()],
    ['2.0.1', 'StatusNotification', P.statusNotification('ocpp2.0.1', { status: 'Available', timestamp: TS })],
    ['2.0.1', 'Authorize',          P.authorize('ocpp2.0.1', { idTag: ID_TAG })],
    ['2.0.1', 'TransactionEvent',   P.transactionEventStarted201({ transactionId: TX_ID_201, idTag: ID_TAG, timestamp: TS, seqNo: 0, meterValue: MV })],
    ['2.0.1', 'TransactionEvent',   P.transactionEventUpdated201({ transactionId: TX_ID_201, timestamp: TS, seqNo: 1, meterValue: MV })],
    ['2.0.1', 'TransactionEvent',   P.transactionEventEnded201({ transactionId: TX_ID_201, timestamp: TS, seqNo: 2, meterValue: MV })],

    // OCPP 2.1 reuses the 2.0.1-shape builders — schemas are wire-compatible for these messages.
    ['2.1',   'BootNotification',   P.bootNotification('ocpp2.1', BOOT)],
    ['2.1',   'Heartbeat',          P.heartbeat()],
    ['2.1',   'StatusNotification', P.statusNotification('ocpp2.1', { status: 'Available', timestamp: TS })],
    ['2.1',   'Authorize',          P.authorize('ocpp2.1', { idTag: ID_TAG })],
    ['2.1',   'TransactionEvent',   P.transactionEventStarted201({ transactionId: TX_ID_201, idTag: ID_TAG, timestamp: TS, seqNo: 0, meterValue: MV })],
    ['2.1',   'TransactionEvent',   P.transactionEventUpdated201({ transactionId: TX_ID_201, timestamp: TS, seqNo: 1, meterValue: MV })],
    ['2.1',   'TransactionEvent',   P.transactionEventEnded201({ transactionId: TX_ID_201, timestamp: TS, seqNo: 2, meterValue: MV })],
];

let failed = 0;
for (const [version, action, payload] of cases) {
    const id = key(version, action);
    const validate = ajv.getSchema(id);
    if (!validate) {
        console.log(`  MISS  [${version}] ${action} — schema ${id} not found`);
        failed++;
        continue;
    }
    if (validate(payload)) {
        console.log(`  OK    [${version}] ${action}`);
    } else {
        failed++;
        console.log(`  FAIL  [${version}] ${action}`);
        for (const err of validate.errors) {
            console.log(`        ${err.instancePath || '(root)'} ${err.message}`);
        }
    }
}

console.log(`\n${cases.length - failed}/${cases.length} payloads valid`);
process.exit(failed === 0 ? 0 : 1);
