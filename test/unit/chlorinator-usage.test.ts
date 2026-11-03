// Cell usage math (controller/ChlorinatorUsage.ts): pure functions, no state.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { cellUsageForHour, cellUsageSince, cellUsageFromSwgEntries, cellUsageFromInstall, mergeSwgEntries } from '../../controller/ChlorinatorUsage';
import type { ChlorinatorOutputHour } from '../../controller/ChlorinatorLog';

const DAY = 86400000;
const hour = (o: Partial<ChlorinatorOutputHour>): ChlorinatorOutputHour => ({ t: '2026-07-01T12:00:00.000Z', id: 1, n: 6, on: 6, out: 50, max: 50, set: 50, tgt: 50, salt: 3200, ...o });

describe('cellUsageForHour', () => {
    it('credits a full hour at the mean output and the rating', () => {
        const u = cellUsageForHour(hour({}), 1.47);
        expect(u.hours).toBeCloseTo(0.5, 10);
        expect(u.pounds).toBeCloseTo(0.5 * 1.47 / 24, 10);
        expect(u.runHours).toBeCloseTo(1, 10);
    });
    it('credits only the time the samples cover', () => {
        const u = cellUsageForHour(hour({ n: 3, on: 3, out: 100 }), 1.47);
        expect(u.hours).toBeCloseTo(0.5, 10);
        expect(u.runHours).toBeCloseTo(0.5, 10);
    });
    it('caps the covered time at one hour (two lines after a restart)', () => {
        expect(cellUsageForHour(hour({ n: 7, on: 7, out: 100 }), 1.47).hours).toBeCloseTo(1, 10);
    });
    it('counts the enabled time from the samples above 0', () => {
        const u = cellUsageForHour(hour({ on: 3, out: 25 }), 1.47);
        expect(u.hours).toBeCloseTo(0.25, 10);
        expect(u.runHours).toBeCloseTo(0.5, 10);
    });
    it('does not credit a stale hour', () => {
        expect(cellUsageForHour(hour({ age: 901 }), 1.47).hours).toBe(0);
        expect(cellUsageForHour(hour({ age: 900 }), 1.47).hours).toBeCloseTo(0.5, 10);
    });
    it('does not credit an hour with a not-generating status, but does with a warning', () => {
        expect(cellUsageForHour(hour({ st: [1] }), 1.47).pounds).toBe(0);
        expect(cellUsageForHour(hour({ st: [129] }), 1.47).pounds).toBe(0);
        expect(cellUsageForHour(hour({ st: [2] }), 1.47).hours).toBeCloseTo(0.5, 10);
        expect(cellUsageForHour(hour({ st: [16] }), 1.47).hours).toBeCloseTo(0.5, 10);
    });
    it('gives no pounds without a rating, and nothing for an empty or zero hour', () => {
        expect(cellUsageForHour(hour({}), 0).pounds).toBe(0);
        expect(cellUsageForHour(hour({ out: 0, on: 0 }), 1.47).hours).toBe(0);
        expect(cellUsageForHour(hour({ n: 0 }), 1.47).hours).toBe(0);
    });
    it('scales the pounds, not the hours, with the rating', () => {
        const a = cellUsageForHour(hour({}), 1.45), b = cellUsageForHour(hour({}), 1.47);
        expect(b.hours).toBe(a.hours);
        expect(b.pounds / a.pounds).toBeCloseTo(1.47 / 1.45, 10);
    });
});

describe('cellUsageSince', () => {
    it('adds the hours from the start time on and reports the first', () => {
        const hours = [hour({ t: '2026-07-01T10:00:00.000Z' }), hour({ t: '2026-07-01T11:00:00.000Z' }), hour({ t: '2026-07-01T12:00:00.000Z' })];
        const u = cellUsageSince(hours, new Date('2026-07-01T11:00:00.000Z').getTime(), 1.47);
        expect(u.hours).toBeCloseTo(1, 10);
        expect(u.firstHour).toBe('2026-07-01T11:00:00.000Z');
    });
});

describe('cellUsageFromSwgEntries', () => {
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    const entries = [
        { ts: t0 - 5 * DAY, ppmPerDay: 9, hrs: 12, pct: 90 },   // before the install date: the old cell's
        { ts: t0, ppmPerDay: 2, hrs: 12, pct: 40 },
        { ts: t0 + 10 * DAY, ppmPerDay: 3, hrs: 12, pct: 60 },
    ];
    it('credits each entry until the next at its ppm for the volume', () => {
        const u = cellUsageFromSwgEntries(entries, t0, t0 + 20 * DAY, 12000, 1.47);
        const pounds = (2 + 3) * 12000 * 8.34 / 1e6 * 10;
        expect(u.pounds).toBeCloseTo(pounds, 10);
        expect(u.hours).toBeCloseTo(pounds * 24 / 1.47, 10);
        expect(u.runHours).toBeCloseTo(240, 10);
    });
    it('uses the % and hours when there is no rating', () => {
        const u = cellUsageFromSwgEntries(entries, t0, t0 + 20 * DAY, 12000, 0);
        expect(u.hours).toBeCloseTo(0.4 * 12 * 10 + 0.6 * 12 * 10, 10);
    });
    it('scales the hours, not the pounds, with the rating', () => {
        const a = cellUsageFromSwgEntries(entries, t0, t0 + 20 * DAY, 12000, 1.45);
        const b = cellUsageFromSwgEntries(entries, t0, t0 + 20 * DAY, 12000, 1.47);
        expect(b.pounds).toBeCloseTo(a.pounds, 10);
        expect(a.hours / b.hours).toBeCloseTo(1.47 / 1.45, 10);
    });
    it('stops at the end time', () => {
        const u = cellUsageFromSwgEntries(entries, t0, t0 + 5 * DAY, 12000, 1.47);
        expect(u.pounds).toBeCloseTo(2 * 12000 * 8.34 / 1e6 * 5, 10);
    });
});

describe('mergeSwgEntries', () => {
    it('drops entries within an hour of an own entry', () => {
        const H = 3600000;
        const own = [{ ts: 1000 * H, ppmPerDay: 2, hrs: 12, pct: 40 }];
        const others = [{ ts: 1000 * H + H / 2, ppmPerDay: 5, hrs: 12, pct: 40 }, { ts: 900 * H, ppmPerDay: 1, hrs: 12, pct: 20 }];
        const m = mergeSwgEntries(own, others);
        expect(m.map(e => e.ppmPerDay)).toEqual([1, 2]);
    });
});

describe('cellUsageFromInstall', () => {
    it('estimates up to the first logged hour, then counts the log', () => {
        const t0 = new Date('2026-07-01T00:00:00Z').getTime();
        const entries = [{ ts: t0, ppmPerDay: 2, hrs: 12, pct: 40 }];
        const hours = [hour({ t: new Date(t0 + 10 * DAY).toISOString(), out: 100 }), hour({ t: new Date(t0 + 10 * DAY + 3600000).toISOString(), out: 100 })];
        const u = cellUsageFromInstall(hours, entries, t0, t0 + 12 * DAY, 12000, 1.47);
        const early = 2 * 12000 * 8.34 / 1e6 * 10;
        expect(u.estimatedPounds).toBeCloseTo(early, 10);
        expect(u.pounds).toBeCloseTo(early + 2 * 1.47 / 24, 10);
        expect(u.firstHour).toBe(new Date(t0 + 10 * DAY).toISOString());
    });
});
