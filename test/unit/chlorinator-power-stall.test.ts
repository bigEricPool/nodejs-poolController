// Short power drops njsPC cannot see (controller/ChlorinatorLogService.ts checkForStall / noteChlorinatorRelayGap): a stall longer than the
// latch of the relays the chlorinator's power is wired through drops them for a moment. The power log is the real one on a temporary file,
// driven with fake clocks; sys and state are small fakes: pump 50 with relays Low (bit 1) and High (bit 2), circuit 7 on the SWG relay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fx = vi.hoisted(() => ({
    controllerType: 'nixie', pumpBits: 1, swgCircuitOn: true, bodyOn: true, file: '',
    chlor: { id: 1, body: 0, powerRelays: [] as { connectionId: string; deviceBinding: string }[], powerConfirmByComms: false } as any,
}));
const REM = 'rem-1';
const LOW = { connectionId: REM, deviceBinding: 'i2c:1:1:1' }, SWG = { connectionId: REM, deviceBinding: 'i2c:1:2:4' };

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/Equipment', () => ({ sys: {
    get controllerType() { return fx.controllerType; },
    pumps: {
        get: () => [{ id: 50 }],
        getItemById: () => ({ relays: { get: () => [{ id: 1, connectionId: REM, deviceBinding: 'i2c:1:1:1' }, { id: 2, connectionId: REM, deviceBinding: 'i2c:1:1:3' }] } }),
    },
    circuits: { get: () => [{ id: 7, connectionId: REM, deviceBinding: 'i2c:1:2:4' }] },
    board: { bodies: { isBodyOn: () => fx.bodyOn } },
    chlorinators: { toArray: () => [fx.chlor] },
} }));
vi.mock('../../controller/State', () => ({ state: {
    pumps: { getItemById: () => ({ relay: fx.pumpBits }) },
    circuits: { getItemById: (id: number) => ({ isOn: id === 7 && fx.swgCircuitOn }) },
    chlorinators: { getItemById: () => ({ lastComm: 0 }) },
} }));
vi.mock('../../controller/Errors', () => ({ ServiceParameterError: class extends Error { } }));
// the real power log, on a file each test sets
vi.mock('../../controller/ChlorinatorPowerLog', async () => {
    const actual: any = await vi.importActual('../../controller/ChlorinatorPowerLog');
    let log: any;
    const cur = () => { if (!log || log.file() !== fx.file) log = new actual.ChlorinatorPowerLog(fx.file); return log; };
    return {
        ...actual,
        chlorinatorPowerLog: {
            record: (...a: any[]) => cur().record(...a), recordDrop: (...a: any[]) => cur().recordDrop(...a),
            lastEvent: (...a: any[]) => cur().lastEvent(...a), read: (...a: any[]) => cur().read(...a),
        },
    };
});

import { checkForStall, chlorinatorPowerLatchMs, markPowerOffWhileStopped, noteChlorinatorRelayGap, resetStallCheck, STALL_TICK_MS } from '../../controller/ChlorinatorLogService';
import { chlorinatorPowerLog } from '../../controller/ChlorinatorPowerLog';

const T = Date.parse('2026-11-13T22:07:40.000Z');
let dir: string;
const lines = () => fs.existsSync(fx.file) ? fs.readFileSync(fx.file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];
const iso = (ms: number) => new Date(ms).toISOString();
// two ticks: one at T, the next `stallMs` beyond the tick interval later
function stall(stallMs: number, wall0: number = T, mono0: number = 1000000) {
    resetStallCheck();
    checkForStall(wall0, mono0);
    return checkForStall(wall0 + STALL_TICK_MS + stallMs, mono0 + STALL_TICK_MS + stallMs);
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chlorstall-'));
    fx.file = path.join(dir, 'chlorinatorPowerLog.jsonl');
    fx.controllerType = 'nixie'; fx.pumpBits = 1; fx.swgCircuitOn = true; fx.bodyOn = true;
    fx.chlor.powerRelays = [SWG, LOW];
    resetStallCheck();
    chlorinatorPowerLog.record(1, true, T - 3600000);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('the stall tick', () => {
    it('writes an off and an on, marked stall, for a 5.1 s stall while powered', () => {
        expect(stall(5100)).toEqual([1]);
        expect(lines().slice(1)).toEqual([
            { t: iso(T + 5000), id: 1, on: false, cause: 'stall' },
            { t: iso(T + STALL_TICK_MS + 5100), id: 1, on: true, cause: 'stall' },
        ]);
        expect(chlorinatorPowerLog.lastEvent(1).on).toBe(true);
    });
    it('writes nothing for a 4 s stall, or for ticks on time', () => {
        expect(stall(4000)).toEqual([]);
        expect(checkForStall(T + 6000, 1000000 + 6000)).toEqual([]);
        expect(lines()).toHaveLength(1);
    });
    it('writes nothing when the power was logged off, or is off now', () => {
        chlorinatorPowerLog.record(1, false, T - 60000);
        expect(stall(8000)).toEqual([]);
        expect(lines()).toHaveLength(2);
        chlorinatorPowerLog.record(1, true, T - 30000);
        fx.pumpBits = 2;      // the low speed relay is off: the cell has no power now
        expect(stall(8000, T + 60000, 2000000)).toEqual([]);
        expect(lines()).toHaveLength(3);
    });
    it('uses the shortest latch of the power relays, 10 s for the SWG relay alone', () => {
        fx.chlor.powerRelays = [SWG];
        expect(chlorinatorPowerLatchMs(fx.chlor)).toBe(10000);
        expect(stall(8000)).toEqual([]);
        expect(stall(10500, T + 60000, 2000000)).toEqual([1]);
        expect(lines()[1]).toEqual({ t: iso(T + 60000 + 10000), id: 1, on: false, cause: 'stall' });
        fx.chlor.powerRelays = [SWG, LOW];
        expect(chlorinatorPowerLatchMs(fx.chlor)).toBe(5000);
        fx.chlor.powerRelays = [];
        expect(chlorinatorPowerLatchMs(fx.chlor)).toBe(5000);    // the default: a cell wired across the pump
    });
    it('measures the gap on the steady clock, so a change of the time is not a stall', () => {
        checkForStall(T, 1000000);
        expect(checkForStall(T + 3600000, 1000000 + STALL_TICK_MS)).toEqual([]);
        expect(lines()).toHaveLength(1);
    });
    it('does nothing on a controller with its own panel', () => {
        fx.controllerType = 'intellicenter';
        expect(stall(20000)).toEqual([]);
        expect(lines()).toHaveLength(1);
    });
});

describe('a restart', () => {
    it('does not add a stall pair to the off and on of a restart', () => {
        // njsPC stops (or starts after a crash): "off" from the stop path; the first tick after the start only sets the clock
        markPowerOffWhileStopped(T);
        resetStallCheck();
        expect(checkForStall(T + 40000, 5)).toEqual([]);
        // a slow start: still logged off, so nothing either
        expect(checkForStall(T + 50000, 5 + 10000)).toEqual([]);
        chlorinatorPowerLog.record(1, true, T + 50000);  // the power check
        expect(lines().map(l => [l.on, l.cause])).toEqual([[true, undefined], [false, undefined], [true, undefined]]);
    });
});

describe('noteChlorinatorRelayGap', () => {
    it('logs a gap of one of the power relays, and only once when the tick saw it too', () => {
        expect(stall(7000)).toEqual([1]);
        const from = T + 200;    // the pump last refreshed its relays a little after the last tick
        expect(noteChlorinatorRelayGap(from, T + STALL_TICK_MS + 7000, [LOW])).toEqual([]);
        expect(lines()).toHaveLength(3);
        // a later gap on the relay manager's side the tick cannot see
        expect(noteChlorinatorRelayGap(T + 600000, T + 612000, [LOW])).toEqual([1]);
        expect(lines().slice(3)).toEqual([
            { t: iso(T + 605000), id: 1, on: false, cause: 'stall' },
            { t: iso(T + 612000), id: 1, on: true, cause: 'stall' },
        ]);
    });
    it('ignores relays the power is not wired through, and gaps within the latch', () => {
        expect(noteChlorinatorRelayGap(T, T + 20000, [{ connectionId: REM, deviceBinding: 'i2c:1:1:3' }])).toEqual([]);
        expect(noteChlorinatorRelayGap(T, T + 9000, [SWG])).toEqual([]);
        fx.chlor.powerRelays = [];
        expect(noteChlorinatorRelayGap(T, T + 20000, [SWG])).toEqual([]);   // no relays set: only a pump relay counts
        expect(noteChlorinatorRelayGap(T, T + 6000, [LOW])).toEqual([1]);
    });
});

describe('readers', () => {
    it('reads the marked lines like any other', () => {
        stall(6000);
        const ev = chlorinatorPowerLog.read(1, T + 60000, 1);
        expect(ev.map(e => e.on)).toEqual([true, false, true]);
        expect(ev[1].cause).toBe('stall');
    });
});
