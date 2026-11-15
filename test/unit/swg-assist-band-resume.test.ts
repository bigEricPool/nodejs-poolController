// How long the SWG is held at 0% above the range (controller/AutoSwgService.ts coastReachTime, controller/SwgAssistBand.ts BAND_STALE_DAYS / BAND_RELEASE_PPM), for the
// status line under "SWG Assist applied ...": the hold ends when the projection (no more chlorine made) falls half a ppm under the top, or when the reading is 3 days old.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { coastReachTime } from '../../controller/AutoSwgService';
import { BAND_RELEASE_PPM, BAND_STALE_DAYS, bandDecision } from '../../controller/SwgAssistBand';

const DAY = 86400000;
const T0 = new Date('2026-11-12T23:46:22.000Z');          // the last reading
const linear = (a: Date, b: Date) => (b.getTime() - a.getTime()) / DAY;
const base = { lastFcTs: T0, lastFcValue: 11.5, generated: 0, added: 0, avgPerDay: 0.48, baseWeight: 0.65, taperStart: 3, taperEnd: 0, level: 9.5, dayEq: linear };

describe('coastReachTime', () => {
    it('is the first hour at which the weighted projection is at or under the level', () => {
        const now = new Date(T0.getTime() + 0.5 * DAY);
        const at = coastReachTime({ ...base, now })!;
        // 11.5 - 0.65 * 0.48 * days <= 9.5  ->  days >= 6.41 after the reading
        const days = (at.getTime() - T0.getTime()) / DAY;
        expect(days).toBeGreaterThanOrEqual(6.41);
        expect(days).toBeLessThan(6.41 + 1 / 24 + 1e-9);
        expect((at.getTime() - now.getTime()) % 3600000).toBe(0);
    });

    it('counts the modelled chlorine made so far and liquid chlorine added since the reading', () => {
        const now = new Date(T0.getTime() + 0.5 * DAY);
        const plain = coastReachTime({ ...base, now })!;
        const withAdd = coastReachTime({ ...base, now, added: 1 })!;           // a ppm more FC: takes longer to fall
        const withGen = coastReachTime({ ...base, now, generated: 0.5 })!;     // 0.5 ppm made (weighted 0.65): takes longer too
        expect(withAdd.getTime()).toBeGreaterThan(plain.getTime());
        expect(withGen.getTime()).toBeGreaterThan(plain.getTime());
    });

    it('is now when the projection is already at the level, and undefined when it never gets there (the taper stops crediting consumption)', () => {
        const now = new Date(T0.getTime() + 0.5 * DAY);
        expect(coastReachTime({ ...base, now, lastFcValue: 9.4 })!.getTime()).toBe(now.getTime());
        expect(coastReachTime({ ...base, now, taperStart: 3, taperEnd: 8 })).toBeUndefined();   // weight 0 from day 8: FC stays above 9.5
        expect(coastReachTime({ ...base, now, avgPerDay: 0.01 })).toBeUndefined();               // 30 days is not enough
    });

    it('follows the day-equivalent function it is given (daylight weighting)', () => {
        const now = new Date(T0.getTime() + 0.5 * DAY);
        const slow = (a: Date, b: Date) => 0.6 * linear(a, b);                 // counts 60% of the time as consumption
        expect(coastReachTime({ ...base, now, dayEq: slow })!.getTime()).toBeGreaterThan(coastReachTime({ ...base, now })!.getTime());
    });
});

describe('the constants match what bandDecision does', () => {
    const input = (projectedFc: number, elapsedDays: number, coasting: boolean) => ({
        projectedFc, avgPerDay: 0.5, elapsedDays, low: 7, high: 10, trim: 0.2, biasPerDay: 0.05, guardPerDay: 0.3, guardCap: 2, maintenancePct: 7, marginPpm: 0,
        periodDayEq: 1, periodRunHours: 10, ppmPerHourAtFull: 0.6, coasting
    });

    it('holds at 0% above the range until the reading is BAND_STALE_DAYS old', () => {
        expect(bandDecision(input(11, BAND_STALE_DAYS - 0.1, false)).mode).toBe('coast');
        expect(bandDecision(input(11, BAND_STALE_DAYS, false)).mode).not.toBe('coast');
    });

    it('releases a hold once the projection is BAND_RELEASE_PPM under the top', () => {
        expect(bandDecision(input(10 - BAND_RELEASE_PPM + 0.01, 1, true)).mode).toBe('coast');
        expect(bandDecision(input(10 - BAND_RELEASE_PPM, 1, true)).mode).not.toBe('coast');
    });
});
