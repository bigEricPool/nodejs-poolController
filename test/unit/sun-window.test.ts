import { describe, expect, it, vi } from 'vitest';
import { calcSunWindow, SunWindowTracker } from '../../controller/nixie/schedules/SunWindow';

// vitest.config.ts pins TZ to America/New_York, so these local dates are New York times.
const at = (y: number, mo: number, d: number, h: number, mi: number, s: number = 0, ms: number = 0) => new Date(y, mo - 1, d, h, mi, s, ms);
const hm = (h: number, m: number) => h * 60 + m;

describe('calcSunWindow length', () => {
    // Daylight 10 h 50 min.
    const sr = at(2026, 11, 15, 6, 40);
    const ss = at(2026, 11, 15, 17, 30);

    it('rounds up to 12 h with N=3', () => {
        expect(calcSunWindow(sr, ss, 3, 'solarNoon').lengthMinutes).toBe(12 * 60);
    });
    it('rounds up to 11 h with N=1', () => {
        expect(calcSunWindow(sr, ss, 1, 'solarNoon').lengthMinutes).toBe(11 * 60);
    });
    it('gives 15 h for a 13.7 h midsummer day with N=3', () => {
        const w = calcSunWindow(at(2026, 6, 21, 6, 27), at(2026, 6, 21, 20, 9), 3, 'solarNoon');
        expect(w.lengthMinutes).toBe(15 * 60);
        // Solar noon 13:18, so 05:48 to 20:48.
        expect(w.startTime).toBe(hm(5, 48));
        expect(w.endTime).toBe(hm(20, 48));
    });
    it('keeps daylight that is already a multiple', () => {
        const sr12 = at(2026, 3, 20, 6, 0, 20);
        const ss12 = at(2026, 3, 20, 18, 0, 20);
        expect(calcSunWindow(sr12, ss12, 3, 'solarNoon').lengthMinutes).toBe(12 * 60);
        expect(calcSunWindow(sr12, ss12, 1, 'solarNoon').lengthMinutes).toBe(12 * 60);
        expect(calcSunWindow(sr12, ss12, 4, 'solarNoon').lengthMinutes).toBe(12 * 60);
        // Sub-second excess over a multiple does not add a block.
        expect(calcSunWindow(sr12, at(2026, 3, 20, 18, 0, 20, 500), 3, 'solarNoon').lengthMinutes).toBe(12 * 60);
        // One minute over does.
        expect(calcSunWindow(sr12, at(2026, 3, 20, 18, 1, 20), 3, 'solarNoon').lengthMinutes).toBe(15 * 60);
    });
    it('caps the window at 24 h, ending at its own start minute', () => {
        const w = calcSunWindow(at(2026, 11, 15, 6, 40), at(2026, 11, 15, 17, 30), 24, 'sunrise');
        expect(w.lengthMinutes).toBe(24 * 60);
        expect(w.startTime).toBe(hm(6, 40));
        expect(w.endTime).toBe(hm(6, 40));
    });
    it('gives whole minutes', () => {
        const w = calcSunWindow(at(2026, 11, 15, 6, 40, 17), at(2026, 11, 15, 17, 30, 43), 3, 'solarNoon');
        expect(Number.isInteger(w.startTime)).toBe(true);
        expect(Number.isInteger(w.endTime)).toBe(true);
    });
});

describe('calcSunWindow placement', () => {
    const sr = at(2026, 11, 15, 6, 40);
    const ss = at(2026, 11, 15, 17, 30);

    it('centres on solar noon by default (N=3)', () => {
        // Solar noon 12:05, 12 h window.
        const w = calcSunWindow(sr, ss, 3, 'solarNoon');
        expect(w.startTime).toBe(hm(6, 5));
        expect(w.endTime).toBe(hm(18, 5));
    });
    it('centres on solar noon (N=1)', () => {
        const w = calcSunWindow(sr, ss, 1, 'solarNoon');
        expect(w.startTime).toBe(hm(6, 35));
        expect(w.endTime).toBe(hm(17, 35));
    });
    it('treats an unknown placement as solar noon', () => {
        expect(calcSunWindow(sr, ss, 3, 'bogus')).toEqual(calcSunWindow(sr, ss, 3, 'solarNoon'));
    });
    it('starts at sunrise', () => {
        const w = calcSunWindow(sr, ss, 3, 'sunrise');
        expect(w.startTime).toBe(hm(6, 40));
        expect(w.endTime).toBe(hm(18, 40));
    });
    it('ends at sunset', () => {
        const w = calcSunWindow(sr, ss, 3, 'sunset');
        expect(w.startTime).toBe(hm(5, 30));
        expect(w.endTime).toBe(hm(17, 30));
    });
    it('covers sunrise to sunset for every placement', () => {
        const srm = hm(6, 40), ssm = hm(17, 30);
        for (const p of ['solarNoon', 'sunrise', 'sunset']) {
            for (const n of [1, 2, 3, 4]) {
                const w = calcSunWindow(sr, ss, n, p);
                expect(w.startTime).toBeLessThanOrEqual(srm);
                expect(w.endTime).toBeGreaterThanOrEqual(ssm);
                expect(w.lengthMinutes % (n * 60)).toBe(0);
            }
        }
    });
});

describe('calcSunWindow on DST change days (America/New_York)', () => {
    it('follows the clock on the spring-forward day', () => {
        // 2026-03-08 clocks go 02:00 EST -> 03:00 EDT.  Sun times move about an hour later on the clock.
        const before = calcSunWindow(at(2026, 3, 7, 6, 30), at(2026, 3, 7, 18, 10), 3, 'solarNoon');
        const day = calcSunWindow(at(2026, 3, 8, 7, 29), at(2026, 3, 8, 19, 11), 3, 'solarNoon');
        // 11 h 40 min -> 12 h, solar noon 12:20 EST.
        expect(before.startTime).toBe(hm(6, 20));
        expect(before.endTime).toBe(hm(18, 20));
        // 11 h 42 min -> 12 h, solar noon 13:20 EDT.
        expect(day.startTime).toBe(hm(7, 20));
        expect(day.endTime).toBe(hm(19, 20));
        expect(day.lengthMinutes).toBe(12 * 60);
    });
    it('follows the clock on the fall-back day', () => {
        // 2026-11-01 clocks go 02:00 EDT -> 01:00 EST.
        const before = calcSunWindow(at(2026, 10, 31, 7, 34), at(2026, 10, 31, 18, 12), 3, 'solarNoon');
        const day = calcSunWindow(at(2026, 11, 1, 6, 35), at(2026, 11, 1, 17, 11), 3, 'solarNoon');
        // 10 h 38 min -> 12 h, solar noon 12:53 EDT.
        expect(before.startTime).toBe(hm(6, 53));
        expect(before.endTime).toBe(hm(18, 53));
        // 10 h 36 min -> 12 h, solar noon 11:53 EST.
        expect(day.startTime).toBe(hm(5, 53));
        expect(day.endTime).toBe(hm(17, 53));
    });
    it('uses the real daylight length when the window spans the switch', () => {
        // A sunrise-anchored 24 h window that starts the day before spring forward still ends at its own start minute.
        const w = calcSunWindow(at(2026, 3, 7, 6, 30), at(2026, 3, 7, 18, 10), 24, 'sunrise');
        expect(w.startTime).toBe(hm(6, 30));
        expect(w.endTime).toBe(hm(6, 30));
    });
});

describe('calcSunWindow invalid input', () => {
    const sr = at(2026, 11, 15, 6, 40);
    const ss = at(2026, 11, 15, 17, 30);
    it('returns undefined for unknown sun times', () => {
        expect(calcSunWindow(undefined, ss, 3, 'solarNoon')).toBeUndefined();
        expect(calcSunWindow(sr, null, 3, 'solarNoon')).toBeUndefined();
        expect(calcSunWindow(new Date(NaN), ss, 3, 'solarNoon')).toBeUndefined();
    });
    it('returns undefined when sunset is not after sunrise', () => {
        expect(calcSunWindow(ss, sr, 3, 'solarNoon')).toBeUndefined();
    });
    it('returns undefined for an invalid hour multiple', () => {
        for (const n of [0, -1, 2.5, 25, NaN, undefined as any, '3' as any]) expect(calcSunWindow(sr, ss, n, 'solarNoon')).toBeUndefined();
    });
});

describe('SunWindowTracker', () => {
    const sr = at(2026, 11, 15, 6, 40);
    const ss = at(2026, 11, 15, 17, 30);
    const sched = (startTime: number, endTime: number) => [{ id: 7, startTime, endTime, hourMultiple: 3, placement: 'solarNoon' }];

    it('reports new times when they differ', () => {
        const t = new SunWindowTracker();
        const warn = vi.fn();
        expect(t.refresh(sched(480, 1020), sr, ss, warn)).toEqual([{ id: 7, startTime: hm(6, 5), endTime: hm(18, 5), lengthMinutes: 720 }]);
        expect(warn).not.toHaveBeenCalled();
    });
    it('reports nothing when the times already match', () => {
        const t = new SunWindowTracker();
        expect(t.refresh(sched(hm(6, 5), hm(18, 5)), sr, ss, vi.fn())).toEqual([]);
    });
    it('keeps the last times and warns once while sunrise is unknown', () => {
        const t = new SunWindowTracker();
        const warn = vi.fn();
        expect(t.refresh(sched(480, 1020), undefined, undefined, warn)).toEqual([]);
        expect(t.refresh(sched(480, 1020), undefined, ss, warn)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        // Once the sun times are back the window is applied and a later loss warns again.
        expect(t.refresh(sched(480, 1020), sr, ss, warn)).toHaveLength(1);
        t.refresh(sched(480, 1020), undefined, undefined, warn);
        expect(warn).toHaveBeenCalledTimes(2);
    });
    it('does nothing and does not warn without sun window schedules', () => {
        const t = new SunWindowTracker();
        const warn = vi.fn();
        expect(t.refresh([], undefined, undefined, warn)).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
    });
});
