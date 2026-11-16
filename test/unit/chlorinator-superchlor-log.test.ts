// The super chlorinate log (controller/ChlorinatorSuperChlorLog.ts), written to a temporary folder: on and off lines, why a run ended, the
// powered hours from the power log, and a run that ended while njsPC was stopped.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { ChlorinatorSuperChlorLog, endReasonOf, poweredHoursBetween, SuperChlorReading, SuperChlorRun } from '../../controller/ChlorinatorSuperChlorLog';

const T = Date.parse('2026-11-15T12:00:00.000Z');
const H = 3600000;
let dir: string;
let runs: SuperChlorRun[];
const lines = () => { const f = path.join(dir, 'chlorinatorSuperChlorLog.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : []; };
const r = (on: boolean, extra: Partial<SuperChlorReading> = {}): SuperChlorReading[] => [{ id: 50, on, remainingSec: on ? 3600 : 0, superChlorHours: 8, bodyOn: true, commsLost: false, ...extra }];
const fullPower = (_id: number, from: number, to: number) => (to - from) / H;
function log() { const l = new ChlorinatorSuperChlorLog(dir); l.onRunEnded(x => runs.push(x)); return l; }

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superchlor-')); runs = []; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('poweredHoursBetween', () => {
    const ev = (t: number, on: boolean) => ({ t: new Date(t).toISOString(), id: 50, on });
    it('counts only the powered part of the span', () => {
        expect(poweredHoursBetween([ev(T - H, true), ev(T + 2 * H, false), ev(T + 3 * H, true)], T, T + 4 * H)).toBe(3);
    });
    it('starts from the state before the span', () => {
        expect(poweredHoursBetween([ev(T - H, false), ev(T + H, true)], T, T + 2 * H)).toBe(1);
    });
    it('counts the whole span when the power log has nothing for it', () => {
        expect(poweredHoursBetween([], T, T + 2 * H)).toBe(2);
    });
});

describe('endReasonOf', () => {
    const base = { startedMs: T, superChlorHours: 8, now: T + H, bodyOn: true, commsLost: false };
    it('tells the reasons apart', () => {
        expect(endReasonOf({ ...base, remainingSecAtLastCheck: 10 })).toBe('timer');
        expect(endReasonOf({ ...base, now: T + 8 * H })).toBe('timer');
        expect(endReasonOf({ ...base, remainingSecAtLastCheck: 3600, bodyOn: false })).toBe('bodyOff');
        expect(endReasonOf({ ...base, remainingSecAtLastCheck: 3600, commsLost: true })).toBe('comms');
        expect(endReasonOf({ ...base, remainingSecAtLastCheck: 3600 })).toBe('turnedOff');
    });
});

describe('ChlorinatorSuperChlorLog', () => {
    it('writes on and off with the run\'s start, reason, hours and powered hours, and tells listeners', () => {
        const l = log();
        l.check(r(false), fullPower, T);
        l.check(r(true), fullPower, T + 15000);
        l.check(r(true), fullPower, T + 30000);
        l.check(r(false, { bodyOn: false }), fullPower, T + 15000 + 2 * H);
        expect(lines()).toEqual([
            { t: new Date(T + 15000).toISOString(), id: 50, on: true },
            { t: new Date(T + 15000 + 2 * H).toISOString(), id: 50, on: false, start: new Date(T + 15000).toISOString(), reason: 'bodyOff', hours: 2, poweredHours: 2 },
        ]);
        expect(runs).toEqual([{ id: 50, start: T + 15000, end: T + 15000 + 2 * H, reason: 'bodyOff', hours: 2, poweredHours: 2, atStartup: false }]);
    });
    it('uses the power log for the powered hours', () => {
        const l = log();
        l.check(r(true), fullPower, T);
        l.check(r(false, { remainingSec: 0 }), () => 1.5, T + 3 * H);
        expect(runs[0].poweredHours).toBe(1.5);
    });
    it('carries a run on across a restart while it is still on', () => {
        log().check(r(true), fullPower, T);
        const again = log();
        again.check(r(true), fullPower, T + H);
        again.check(r(false), fullPower, T + 2 * H);
        expect(lines().filter(x => x.on).length).toBe(1);
        expect(runs[0]).toMatchObject({ start: T, end: T + 2 * H, atStartup: false });
    });
    it('ends a run that finished while njsPC was stopped when it was last seen running', () => {
        const l = log();
        l.check(r(true), fullPower, T);
        l.check(r(true), fullPower, T + 30 * 60000);
        l.markSeen([50], T + H);          // njsPC stops
        const again = log();
        again.check(r(false), fullPower, T + 5 * H);
        expect(runs).toEqual([{ id: 50, start: T, end: T + H, reason: 'stopped', hours: 1, poweredHours: 1, atStartup: true }]);
    });
    it('writes nothing while the clock is not set', () => {
        log().check(r(true), fullPower, Date.UTC(2020, 0, 1));
        expect(lines()).toEqual([]);
    });
});
