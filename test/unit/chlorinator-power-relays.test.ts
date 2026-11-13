// A chlorinator's power from its own settings (controller/ChlorinatorLogService.ts): the relays its power is wired through (a dead-man) and the
// RS-485 link as proof. sys and state are small fakes: pump 50 with relays Low (bit 1), High (bit 2), Med (bit 4); circuit 7 on the SWG relay.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
    pumpBits: 0, swgCircuitOn: false, bodyOn: true, lastComm: 0,
    chlor: { id: 1, body: 0, powerRelays: [] as { connectionId: string; deviceBinding: string }[], powerConfirmByComms: false } as any,
}));
const REM = 'rem-1';
const LOW = { connectionId: REM, deviceBinding: 'i2c:1:1:1' }, SWG = { connectionId: REM, deviceBinding: 'i2c:1:2:4' };

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/Equipment', () => ({ sys: {
    pumps: {
        get: () => [{ id: 50 }],
        getItemById: () => ({ relays: { get: () => [{ id: 1, connectionId: REM, deviceBinding: 'i2c:1:1:1' }, { id: 2, connectionId: REM, deviceBinding: 'i2c:1:1:3' }, { id: 3, connectionId: REM, deviceBinding: 'i2c:1:1:2' }] } }),
    },
    circuits: { get: () => [{ id: 7, connectionId: REM, deviceBinding: 'i2c:1:2:4' }] },
    board: { bodies: { isBodyOn: () => fx.bodyOn } },
    chlorinators: { toArray: () => [fx.chlor] },
} }));
vi.mock('../../controller/State', () => ({ state: {
    pumps: { getItemById: () => ({ relay: fx.pumpBits }) },
    circuits: { getItemById: (id: number) => ({ isOn: id === 7 && fx.swgCircuitOn }) },
    chlorinators: { getItemById: () => ({ lastComm: fx.lastComm }) },
} }));
vi.mock('../../controller/Errors', () => ({ ServiceParameterError: class extends Error { } }));

import { checkCellSettings, chlorinatorPower, decidePower, relayIsOn, setChlorinatorPowerSource } from '../../controller/ChlorinatorLogService';

const T = Date.parse('2026-11-13T15:00:00.000Z');
const old = () => ({ on: true as boolean | undefined, by: 'body' as const });
beforeEach(() => {
    fx.pumpBits = 0; fx.swgCircuitOn = false; fx.bodyOn = true; fx.lastComm = 0;
    fx.chlor.powerRelays = []; fx.chlor.powerConfirmByComms = false;
    setChlorinatorPowerSource(undefined);
});

describe('the rule', () => {
    it('needs every relay on', () => {
        expect(decidePower([true, true], undefined, false, 0, old)).toEqual({ on: true, by: 'relays' });
        expect(decidePower([true, false], undefined, false, 0, old)).toEqual({ on: false, by: 'relays' });
    });
    it('uses the old answer when there are no relays or one is not known', () => {
        expect(decidePower([], undefined, false, 0, old).by).toBe('body');
        expect(decidePower([true, undefined], undefined, false, 0, old).by).toBe('body');
    });
    it('lets an answer on RS-485 prove power when the relays say off, and flags it', () => {
        expect(decidePower([true, false], 5, true, 0, old)).toEqual({ on: true, by: 'comms', confirmed: false, mismatch: 'answering' });
    });
    it('confirms relays on with an answer, and flags a long silence without turning the power off', () => {
        expect(decidePower([true, true], 5, true, 600, old)).toEqual({ on: true, by: 'relays', confirmed: true });
        expect(decidePower([true, true], 300, true, 30, old)).toEqual({ on: true, by: 'relays', confirmed: false });
        expect(decidePower([true, true], 300, true, 600, old)).toEqual({ on: true, by: 'relays', confirmed: false, mismatch: 'silent' });
    });
    it('decides by the link alone when no relays are set', () => {
        expect(decidePower([], 5, true, 0, old)).toEqual({ on: true, by: 'comms', confirmed: true });
        expect(decidePower([], 120, true, 0, old)).toEqual({ on: false, by: 'comms', confirmed: true });
    });
});

describe('relay state from njsPC\'s own record', () => {
    it('reads a pump relay from the pump\'s bits and any other from its circuit', () => {
        fx.pumpBits = 1 | 2;
        expect(relayIsOn(LOW)).toBe(true);
        fx.pumpBits = 4;
        expect(relayIsOn(LOW)).toBe(false);
        expect(relayIsOn(SWG)).toBe(false);
        fx.swgCircuitOn = true;
        expect(relayIsOn(SWG)).toBe(true);
        expect(relayIsOn({ connectionId: REM, deviceBinding: 'i2c:9:9:9' })).toBeUndefined();
    });
});

describe('a chlorinator dead-manned to its own relay and the pump\'s low speed', () => {
    it('has power only with both on, whatever the body or another module says', () => {
        fx.chlor.powerRelays = [SWG, LOW];
        setChlorinatorPowerSource(() => true);
        fx.swgCircuitOn = true; fx.pumpBits = 4;          // Med only: the low speed relay is off
        expect(chlorinatorPower(fx.chlor, T).on).toBe(false);
        fx.pumpBits = 1 | 4;                              // Low and Med
        expect(chlorinatorPower(fx.chlor, T)).toEqual({ on: true, by: 'relays' });
        fx.swgCircuitOn = false; fx.bodyOn = true;
        expect(chlorinatorPower(fx.chlor, T).on).toBe(false);
    });
    it('keeps today\'s answer without the settings', () => {
        fx.bodyOn = false;
        expect(chlorinatorPower(fx.chlor, T)).toEqual({ on: false, by: 'body' });
        setChlorinatorPowerSource(() => true);
        expect(chlorinatorPower(fx.chlor, T)).toEqual({ on: true, by: 'source' });
    });
    it('confirms the relays with the RS-485 link', () => {
        fx.chlor.powerRelays = [SWG, LOW]; fx.chlor.powerConfirmByComms = true;
        fx.swgCircuitOn = true; fx.pumpBits = 1;
        fx.lastComm = T - 3000;
        expect(chlorinatorPower(fx.chlor, T)).toEqual({ on: true, by: 'relays', confirmed: true });
        fx.pumpBits = 0;
        expect(chlorinatorPower(fx.chlor, T).mismatch).toBe('answering');
    });
});

describe('the settings check', () => {
    it('takes a list of relays and the switch, and refuses a bad list', () => {
        expect(checkCellSettings({ powerRelays: [SWG, LOW], powerConfirmByComms: 'true' })).toMatchObject({ powerRelays: [SWG, LOW], powerConfirmByComms: true });
        expect(checkCellSettings({ powerRelays: null }).powerRelays).toEqual([]);
        expect(() => checkCellSettings({ powerRelays: [{ connectionId: REM }] })).toThrow();
        expect(() => checkCellSettings({ powerRelays: [LOW, LOW, LOW, LOW, LOW] })).toThrow();
    });
});
