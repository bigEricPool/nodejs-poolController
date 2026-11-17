// Counting a cell by its cycles (controller/ChlorinatorUsage.ts cycleConduction and the cycle context): current flows for the set % of
// each cycle, and a cycle starts when the power comes on.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { CycleSettings, cellUsageForHour, cellUsageSince, conductingIntervals, cycleConduction, hourPct, pctAtFromHours } from '../../controller/ChlorinatorUsage';
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
        // a line that covers half the hour (njsPC restarted in it) counts the span it is given, the hour by default
        expect(cellUsageForHour(hour({ n: 3, on: 3 }), 1.47, ctx, [at(0), at(0.5)]).hours).toBeCloseTo(0.5, 10);
        expect(cellUsageForHour(hour({ n: 3, on: 3 }), 1.47, ctx, [at(0.5), at(2)]).hours).toBeCloseTo(0.5, 10);
        expect(cellUsageForHour(hour({ n: 3, on: 3 }), 1.47, ctx).hours).toBeCloseTo(1, 10);
        expect(cellUsageForHour(hour({}), 1.47, ctx, [at(1), at(2)]).hours).toBe(0);
    });
    it('counts an hour before it by its mean output', () => {
        const u = cellUsageForHour(hour({ t: new Date(at(-1)).toISOString() }), 1.47, ctx);
        expect(u.cycle).toBeUndefined();
        expect(u.hours).toBeCloseTo(0.34, 10);
    });
    it('credits nothing for a fault the cell reported; the power log, not a stale output or lost comms, says when it had power', () => {
        expect(cellUsageForHour(hour({ st: [1] }), 1.47, ctx).hours).toBe(0);
        expect(cellUsageForHour(hour({ st: [129] }), 1.47, ctx).hours).toBe(0);
        expect(cellUsageForHour(hour({ age: 901 }), 1.47, ctx).hours).toBeCloseTo(1, 10);
        expect(cellUsageForHour(hour({ st: [128], age: 40000, out: 2 }), 1.47, ctx).hours).toBeCloseTo(1, 10);
        expect(cellUsageForHour(hour({ st: [128, 16] }), 1.47, ctx).hours).toBeCloseTo(1, 10);
        // the % of the cycle comes from the % in force, so a line whose mean output is 0 still counts a cycle begun before it
        expect(cellUsageForHour(hour({ out: 0, on: 0 }), 1.47, ctx).hours).toBeCloseTo(1, 10);
    });
    it('counts an hour with several lines once, at most its enabled time, and only up to the time given', () => {
        const lines = [hour({ n: 3, on: 3 }), hour({ n: 4, on: 4 })];
        const u = cellUsageSince(lines, at(-2), 1.47, ctx);
        expect(u.hours).toBeCloseTo(1, 10);
        expect(u.runHours).toBeCloseTo(1, 10);
        expect(u.cycleHourCount).toBe(1);
        expect(cellUsageSince(lines, at(-2), 1.47, ctx, at(0.25)).hours).toBeCloseTo(0.25, 10);
        expect(cellUsageSince([hour({ n: 3, on: 3 }), hour({ n: 3, on: 3, st: [8] })], at(-2), 1.47, ctx).hours).toBe(0);
    });
    it('says how many hours were counted by cycles', () => {
        const hours = [hour({ t: new Date(at(-1)).toISOString() }), hour({}), hour({ t: new Date(at(1)).toISOString() })];
        const u = cellUsageSince(hours, at(-2), 1.47, ctx);
        expect(u.cycleHourCount).toBe(2);
        expect(u.hours).toBeCloseTo(0.34 + 1 + 0.02, 10);
    });
});

describe('conductingIntervals', () => {
    const iv = (ev: { t: number; on: boolean }[], a: number, b: number, c: CycleSettings, p: (ms: number) => number) =>
        conductingIntervals(ev, a, b, c, p).map(x => [x.start, x.end, x.cycle, x.pct]);
    const MIN = 60000;
    it('are the bursts of each cycle, and add up to cycleConduction over any window', () => {
        const ev = [{ t: at(0), on: true }, { t: at(7), on: false }];
        expect(iv(ev, at(0), at(10), C3, pct(34))).toEqual([[at(0), at(1.02), at(0), 34], [at(3), at(4.02), at(3), 34], [at(6), at(7), at(6), 34]]);
        for (const [a, b] of [[0, 10], [0.5, 3.5], [1, 2], [6.5, 9]]) {
            const sum = conductingIntervals(ev, at(a), at(b), C3, pct(34)).reduce((s, x) => s + x.end - x.start, 0) / H;
            expect(sum).toBe(cycleConduction(ev, at(a), at(b), C3, pct(34)));
        }
        // cut to the window asked for, keeping the cycle start
        expect(iv(ev, at(0.5), at(3.5), C3, pct(34))).toEqual([[at(0.5), at(1.02), at(0), 34], [at(3), at(3.5), at(3), 34]]);
    });
    it('start a new cycle at a restart part way through a cycle', () => {
        const ev = [{ t: at(0), on: true }, { t: at(2), on: false }, { t: at(2.5), on: true }, { t: at(6), on: false }];
        expect(iv(ev, at(0), at(8), C3, pct(50))).toEqual([[at(0), at(1.5), at(0), 50], [at(2.5), at(4), at(2.5), 50], [at(5.5), at(6), at(5.5), 50]]);
        // without restarts the cycles run on from the first power-on: the 0 h burst is over before the power comes back, the 3 h cycle bursts to 4.5 h
        expect(iv(ev, at(0), at(8), { ...C3, restartsOnPower: false }, pct(50))).toEqual([[at(0), at(1.5), at(0), 50], [at(3), at(4.5), at(3), 50]]);
    });
    it('keep the % of the cycle start through a burst when the % changes part way through it', () => {
        // 40% of 3 h is 1.2 h; the % goes to 0 at 0.5 h, and the burst still runs to 1.2 h; the next cycle at 3 h is at 0% and conducts nothing
        const p = (ms: number) => ms < at(0.5) ? 40 : 0;
        expect(iv([{ t: at(0), on: true }], at(0), at(6), C3, p)).toEqual([[at(0), at(1.2), at(0), 40]]);
    });
    it('are none at 0%', () => {
        expect(iv([{ t: at(0), on: true }, { t: at(5), on: false }], at(0), at(6), C3, pct(0))).toEqual([]);
    });
    it('stop where the power goes off part way through a burst', () => {
        expect(iv([{ t: at(0), on: true }, { t: at(0.5), on: false }], at(0), at(6), C3, pct(50))).toEqual([[at(0), at(0.5), at(0), 50]]);
    });
    it('treat a stall pair (off then on a moment later) as a restart', () => {
        const stall = at(1) + 100;
        const ev = [{ t: at(0), on: true }, { t: at(1), on: false }, { t: stall, on: true }, { t: at(3), on: false }];
        expect(iv(ev, at(0), at(4), C3, pct(10))).toEqual([[at(0), at(0.3), at(0), 10], [stall, stall + 0.3 * H, stall, 10]]);
    });
    it('put the burst at the end of the cycle when burstFirst is off', () => {
        expect(iv([{ t: at(0), on: true }, { t: at(4), on: false }], at(0), at(6), { ...C3, burstFirst: false }, pct(50))).toEqual([[at(1.5), at(3), at(0), 50]]);
    });
    it('match a morning of 2026-11-17: on at 06:50 at 9%, the 09:50 cycle bursts to 10:06, 0% from 10:00, a 0% cycle from the 10:15 restart', () => {
        const T = (hh: number, mm: number) => Date.UTC(2026, 10, 17, hh + 5, mm);  // EST is UTC-5
        const p = (ms: number) => ms < T(10, 0) ? 9 : 0;
        const ev = [{ t: T(6, 50), on: true }, { t: T(10, 15), on: false }, { t: T(10, 15) + 1000, on: true }, { t: T(16, 0), on: false }];
        const burst = 0.09 * 3 * 60 * MIN;   // 16.2 min
        expect(iv(ev, T(6, 0), T(17, 0), C3, p)).toEqual([[T(6, 50), T(6, 50) + burst, T(6, 50), 9], [T(9, 50), T(9, 50) + burst, T(9, 50), 9]]);
    });
});
