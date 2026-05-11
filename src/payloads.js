(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.OCPPPayloads = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    const is16 = (version) => version === 'ocpp1.6';

    const STATUS_21_TO_16 = {
        Available: 'Available',
        Occupied: 'Charging',
        Reserved: 'Reserved',
        Unavailable: 'Unavailable',
        Faulted: 'Faulted',
    };

    function status21To16(status21) {
        return STATUS_21_TO_16[status21] ?? 'Available';
    }

    function meterValue(version, { timestamp, meterValue }) {
        const sampledValue = { measurand: 'Energy.Active.Import.Register' };
        if (is16(version)) {
            sampledValue.value = String(meterValue);
            sampledValue.unit = 'Wh';
        } else {
            sampledValue.value = meterValue;
            sampledValue.unitOfMeasure = { unit: 'Wh' };
        }
        return { timestamp, sampledValue: [sampledValue] };
    }

    function bootNotification(version, { vendor, model, serialNumber, firmwareVersion }) {
        return is16(version)
            ? { chargePointVendor: vendor, chargePointModel: model, chargePointSerialNumber: serialNumber, firmwareVersion }
            : { chargingStation: { vendorName: vendor, model, serialNumber, firmwareVersion }, reason: 'PowerUp' };
    }

    function heartbeat() {
        return {};
    }

    function statusNotification(version, { status, timestamp }) {
        return is16(version)
            ? { connectorId: 1, status: status21To16(status), errorCode: 'NoError', timestamp }
            : { timestamp, connectorStatus: status, evseId: 1, connectorId: 1 };
    }

    function authorize(version, { idTag }) {
        return is16(version)
            ? { idTag }
            : { idToken: { idToken: idTag, type: 'ISO14443' } };
    }

    function startTransaction16({ idTag, timestamp, meterStart }) {
        return { idTag, connectorId: 1, meterStart, timestamp };
    }

    function stopTransaction16({ transactionId, meterStop, timestamp }) {
        return { transactionId, meterStop, timestamp };
    }

    function meterValues16({ transactionId, timestamp, meterValue: mv }) {
        return {
            connectorId: 1,
            transactionId,
            meterValue: [meterValue('ocpp1.6', { timestamp, meterValue: mv })],
        };
    }

    function transactionEventStarted201({ transactionId, idTag, timestamp, seqNo, meterValue: mv }) {
        return {
            eventType: 'Started', timestamp, triggerReason: 'Authorized', seqNo,
            transactionInfo: { transactionId },
            idToken: { idToken: idTag, type: 'ISO14443' },
            evse: { id: 1, connectorId: 1 },
            meterValue: [meterValue('ocpp2.0.1', { timestamp, meterValue: mv })],
        };
    }

    function transactionEventUpdated201({ transactionId, timestamp, seqNo, meterValue: mv }) {
        return {
            eventType: 'Updated', timestamp, triggerReason: 'MeterValuePeriodic', seqNo,
            transactionInfo: { transactionId },
            evse: { id: 1, connectorId: 1 },
            meterValue: [meterValue('ocpp2.0.1', { timestamp, meterValue: mv })],
        };
    }

    function transactionEventEnded201({ transactionId, timestamp, seqNo, meterValue: mv }) {
        return {
            eventType: 'Ended', timestamp, triggerReason: 'StopAuthorized', seqNo,
            transactionInfo: { transactionId },
            meterValue: [meterValue('ocpp2.0.1', { timestamp, meterValue: mv })],
        };
    }

    return {
        bootNotification,
        heartbeat,
        statusNotification,
        authorize,
        startTransaction16,
        stopTransaction16,
        meterValues16,
        transactionEventStarted201,
        transactionEventUpdated201,
        transactionEventEnded201,
        meterValue,
        status21To16,
    };
}));