// Counting a cell by its cycles (controller/ChlorinatorUsage.ts cycleConduction and the cycle context): current flows for the set % of
// each cycle, and a cycle starts when the power comes on.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { CycleSettings, cellUsageForHour, cellUsageSince, cycleConduction, hourPct, pctAtFromHours } from '../../controller/ChlorinatorUsage';
import type { ChlorinatorOutputHour } from '../../controller/ChlorinatorLog';

const H = 3600000;
const T0 = Date.parse('2026-07-01T12:00:00.000Z');
const at = (h: number) => T0 + h * H;
const C3: CycleSettings = { cycleHours: 3, restartsOnPower: true, burstFirst: true };
const pct = (p: number) => () => p;
const hour = (o: Partial<ChlorinatorOutputHour>): ChlorinatorOutputHour => ({ t: new Date(T0).toISOString(), id: 1, n: 6, on: 6, out: 34, max: 34, set: 34, tgt: 34, salt: 3200, ...o });

describe('cycleConduction', () => {
    it('counts a powered time that is not a whole number of cycles', () => {
        // 34% of 3 h is 1.02 h a cycle: two whole cycles and the first 1 h of the third (the power goes off at 7 h)
        const ev = [{ t: at(0), on: true }, { t: at(7), on: false }];
        expect(cycleConduction(ev, at(0), at(10), C3, pct(34))).toBeCloseTo(3.04, 10);
    });
    it('adds up the same over hour windows as over the whole time', () => {
        const ev = [{ t: at(0), on: true }, { t: at(7), on: false }];
        let sum = 0;
        for (let h = 0; h < 10; h++) sum += cycleConduction(ev, at(h), at(h + 1), C3, pct(34));
        expect(sum).toBeCloseTo(3.04, 10);
        expect(cycleConduction(ev, at(1), at(2), C3, pct(34))).toBeCloseTo(0.02, 10);
    });
    it('starts a new cycle when the power comes back inside a cycle', () => {
        const ev = [{ t: at(0), on: true }, { t: at(2), on: false }, { t: at(2.5), on: true }, { t: at(6), on: false }];
        // restarting: 1.5 h, then cycles from 2.5 h: 1.5 h, and 0.5 h of the next before the power goes off at 6 h
        expect(cycleConduction(ev, at(0), at(8), C3, pct(50))).toBeCloseTo(3.5, 10);
        // not restarting: the cycles run on from 0 h, and the burst at 0 h was over before the power came back
        expect(cycleConduction(ev, at(0), at(8), { ...C3, restartsOnPower: false }, pct(50))).toBeCloseTo(3.0, 10);
    });
    it('uses the % in force at each cycle start', () => {
        const ev = [{ t: at(0), on: true }, { t: at(6), on: false }];
        const p = (ms: number) => ms < at(3) ? 40 : 80;
        expect(cycleConduction(ev, at(0), at(6), C3, p)).toBeCloseTo(1.2 + 2.4, 10);
    });
    it('puts the current at the end of the cycle when burstFirst is off', () => {
        const ev = [{ t: at(0), on: true }, { t: at(4), on: false }];
        expect(cycleConduction(ev, at(0), at(6), { ...C3, burstFirst: false }, pct(50))).toBeCloseTo(1.5, 10);
    });
    it('counts nothing without a cycle length or power', () => {
        const ev = [{ t: at(0), on: true }];
        expect(cycleConduction(ev, at(0), at(3), { ...C3, cycleHours: 0 }, pct(50))).toBe(0);
        expect(cycleConduction([], at(0), at(3), C3, pct(50))).toBe(0);
        expect(cycleConduction([{ t: at(0), on: false }], at(0), at(3), C3, pct(50))).toBe(0);
    });
    it('keeps counting while the power is still on', () => {
        expect(cycleConduction([{ t: at(0), on: true }], at(3), at(4), C3, pct(34))).toBeCloseTo(1, 10);
    });
});

describe('the % in force', () => {
    it('is the target output of a producing hour, else 0', () => {
        expect(hourPct(hour({}))).toBe(34);
        expect(hourPct(hour({ out: 0, on: 0 }))).toBe(0);
        expect(hourPct(hour({ tgt: 0, max: 40 }))).toBe(40);
    });
    it('comes from the hour a time falls in, the line with more samples for a repeated hour', () => {
        const p = pctAtFromHours([hour({ n: 2, tgt: 20 }), hour({ n: 4, tgt: 60 }), hour({ t: new Date(at(1)).toISOString(), tgt: 30 })]);
        expect(p(at(0.5))).toBe(60);
        expect(p(at(1.9))).toBe(30);
        expect(p(at(5))).toBe(0);
    });
});

describe('cellUsageForHour with cycles', () => {
    const ctx = { cycle: C3, events: [{ t: at(0), on: true }], since: at(0), pctAt: pct(34) };
    it('counts an hour after the power log began by its cycles', () => {
        const u = cellUsageForHour(hour({}), 1.47, ctx);
        expect(u.cycle).toBe(true);
        expect(u.hours).toBeCloseTo(1, 10);   // the first hour of a 1.02 h burst
        expect(u.pounds).toBeCloseTo(1.47 / 24, 10);
        const half = cellUsageForHour(hour({ n: 3, on: 3 }), 1.47, ctx);   // a line that covers half the hour
        expect(half.hours).toBeCloseTo(0.5, 10);
    });
    it('counts an hour before it by its mean output', () => {
        const u = cellUsageForHour(hour({ t: new Date(at(-1)).toISOString() }), 1.47, ctx);
        expect(u.cycle).toBeUndefined();
        expect(u.hours).toBeCloseTo(0.34, 10);
    });
    it('still credits nothing for a stale hour or one that was not generating', () => {
        expect(cellUsageForHour(hour({ age: 901 }), 1.47, ctx).hours).toBe(0);
        expect(cellUsageForHour(hour({ st: [1] }), 1.47, ctx).hours).toBe(0);
    });
    it('says how many hours were counted by cycles', () => {
        const hours = [hour({ t: new Date(at(-1)).toISOString() }), hour({}), hour({ t: new Date(at(1)).toISOString() })];
        const u = cellUsageSince(hours, at(-2), 1.47, ctx);
        expect(u.cycleHourCount).toBe(2);
        expect(u.hours).toBeCloseTo(0.34 + 1 + 0.02, 10);
    });
});
