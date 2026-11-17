// The "off" after a stop that wrote nothing (controller/ChlorinatorLogService.ts markPowerOffAfterOutage): a crash, a kill or a power loss
// leaves the power log's last line "on"; the start writes the "off" at the last time njsPC was known to be running (the later of the last
// power check, lastAlive, and the chlorinator's last answer, lastComm), plus the relay latch, not at the start. The power log is the real
// one on a temporary file; sys and state are small fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fx = vi.hoisted(() => ({
    controllerType: 'nixie',
    log: undefined as any,
    states: {} as { [id: number]: { lastAlive?: number; lastComm?: number } },
}));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/Equipment', () => ({ sys: {
    get controllerType() { return fx.controllerType; },
    chlorinators: { toArray: () => [{ id: 50 }] },
} }));
vi.mock('../../controller/State', () => ({ state: { chlorinators: { getItemById: (id: number) => fx.states[id] } } }));
vi.mock('../../controller/Errors', () => ({ ServiceParameterError: class extends Error { } }));
vi.mock('../../controller/ChlorinatorPowerLog', () => ({ chlorinatorPowerLog: {
    lastEvent: (id: number) => fx.log.lastEvent(id),
    record: (id: number, on: boolean, now?: number, cause?: any) => fx.log.record(id, on, now, cause),
} }));

import { markPowerOffAfterOutage, markPowerOffWhileStopped, outageOffTime, OUTAGE_RELAY_LATCH_MS } from '../../controller/ChlorinatorLogService';

const H = 3600000, MIN = 60000;
const MORNING = Date.parse('2026-11-16T11:45:00.000Z');   // the power on, 06:45 local
let dir: string, file: string;
const lines = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];

beforeEach(async () => {
    const { ChlorinatorPowerLog } = await vi.importActual<any>('../../controller/ChlorinatorPowerLog');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chloroutage-'));
    file = path.join(dir, 'chlorinatorPowerLog.jsonl');
    fx.log = new ChlorinatorPowerLog(file);
    fx.controllerType = 'nixie';
    fx.states = { 50: {} };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('outageOffTime', () => {
    it('is the latest of the "on", the last check and the last answer, plus the latch', () => {
        expect(outageOffTime(MORNING, MORNING + H, MORNING + H - 10000)).toBe(MORNING + H + OUTAGE_RELAY_LATCH_MS);
        expect(outageOffTime(MORNING, MORNING + H - 10000, MORNING + H)).toBe(MORNING + H + OUTAGE_RELAY_LATCH_MS);
        // both older than the "on" (njsPC died before it saved them): the "on" itself
        expect(outageOffTime(MORNING, MORNING - H, undefined)).toBe(MORNING + OUTAGE_RELAY_LATCH_MS);
        expect(outageOffTime(MORNING, undefined, NaN)).toBe(MORNING + OUTAGE_RELAY_LATCH_MS);
    });
});

describe('markPowerOffAfterOutage', () => {
    it('a crash in the run window: the "off" lands at the last time njsPC was running, marked "outage", not at the start', () => {
        fx.log.record(50, true, MORNING);
        fx.states[50] = { lastAlive: MORNING + 2 * H, lastComm: MORNING + 2 * H - 3000 };
        markPowerOffAfterOutage();   // the start, whatever its time
        expect(lines()[1]).toEqual({ t: new Date(MORNING + 2 * H + OUTAGE_RELAY_LATCH_MS).toISOString(), id: 50, on: false, cause: 'outage' });
    });
    it('a crash in the afternoon, started again the next morning: the night does not count as powered', () => {
        fx.log.record(50, true, MORNING);
        fx.states[50] = { lastAlive: MORNING + 4 * H, lastComm: MORNING + 4 * H - 2000 };
        markPowerOffAfterOutage();
        const off = new Date(lines()[1].t).getTime();
        expect(off).toBe(MORNING + 4 * H + OUTAGE_RELAY_LATCH_MS);
        expect(off).toBeLessThan(MORNING + 20 * H);   // well before the next morning's start
    });
    it('a boot clock behind the last line: the "off" does not depend on it, and the "on" waits until the clock has passed it', () => {
        fx.log.record(50, true, MORNING);
        fx.states[50] = { lastAlive: MORNING + H };
        const bootClock = MORNING - 30 * MIN;   // the clock file's time, before the last line
        markPowerOffAfterOutage();
        expect(lines()[1]).toEqual({ t: new Date(MORNING + H + OUTAGE_RELAY_LATCH_MS).toISOString(), id: 50, on: false, cause: 'outage' });
        expect(fx.log.record(50, true, bootClock)).toBeUndefined();
        expect(fx.log.record(50, true, MORNING + H + 2 * MIN)).toBeDefined();   // once synced
        expect(lines()).toHaveLength(3);
    });
    it('a clean stop wrote its "off": nothing more at the start', () => {
        fx.log.record(50, true, MORNING);
        markPowerOffWhileStopped(MORNING + 3 * H);
        fx.states[50] = { lastAlive: MORNING + 3 * H };
        markPowerOffAfterOutage();
        expect(lines()).toEqual([
            { t: new Date(MORNING).toISOString(), id: 50, on: true },
            { t: new Date(MORNING + 3 * H).toISOString(), id: 50, on: false },
        ]);
    });
    it('njsPC died right after logging the power on, before saving its state: the "off" is just after the "on"', () => {
        fx.log.record(50, true, MORNING);
        fx.states[50] = { lastAlive: MORNING - 10 * H };
        markPowerOffAfterOutage();
        expect(new Date(lines()[1].t).getTime()).toBe(MORNING + OUTAGE_RELAY_LATCH_MS);
    });
    it('a controller with its own panel keeps the power on through njsPC stopping: nothing is written', () => {
        fx.controllerType = 'intellicenter';
        fx.log.record(50, true, MORNING);
        fx.states[50] = { lastAlive: MORNING + H };
        markPowerOffAfterOutage();
        expect(lines()).toHaveLength(1);
    });
});
