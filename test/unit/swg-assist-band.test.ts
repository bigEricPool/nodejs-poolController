// SWG Assist range control (controller/SwgAssistBand.ts): the hold, and its two corrections (the peak cap and the integral correction).
import { describe, expect, it } from 'vitest';
import { bandDecision, BandInput } from '../../controller/SwgAssistBand';

// A pool whose cell makes 0.6 ppm per run hour at 100% over a 7 hour window: the maintenance % that matches 0.84 ppm/day of burn is 20%.
function input(over: Partial<BandInput>): BandInput {
    return Object.assign({
        projectedFc: 8.5, avgPerDay: 0.84, elapsedDays: 0.5, low: 7, high: 10, trim: 0.2, biasPerDay: 0.05, guardPerDay: 0.3, guardCap: 2,
        maintenancePct: 20, marginPpm: 0, periodDayEq: 1, periodRunHours: 7, ppmPerHourAtFull: 0.6, coasting: false
    } as BandInput, over);
}

describe('range control hold', () => {
    it('holds the maintenance % in the middle of the range with neither correction on', () => {
        const d = bandDecision(input({}));
        expect(d.mode).toBe('hold');
        expect(d.pct).toBeCloseTo(20, 5);
        expect(d.peakCapped).toBe(false);
    });

    it('still coasts at 0% above the range whatever the corrections say', () => {
        const d = bandDecision(input({ projectedFc: 10.5, peakCap: true, peakRunHours: 7, peakDayEq: 0.4, integral: 0.3, recentReadings: [8, 8, 8] }));
        expect(d.mode).toBe('coast');
        expect(d.pct).toBe(0);
    });
});

describe('peak cap', () => {
    const peak = { peakCap: true, peakRunHours: 7, peakDayEq: 0.4 };

    it('lowers the hold so the afternoon peak stays under the top of the range', () => {
        // FC 9.5 now: the trim alone would give 17.3%, and the run would add 0.042 ppm per % less 0.336 ppm of burn, so the peak under 9.75 allows 13.95%
        const plain = bandDecision(input({ projectedFc: 9.5 }));
        const capped = bandDecision(input(Object.assign({ projectedFc: 9.5 }, peak)));
        expect(plain.pct).toBeCloseTo(17.33, 1);
        expect(capped.pct).toBeCloseTo(13.95, 1);
        expect(capped.peakCapped).toBe(true);
        expect(capped.note).toContain('peak');
    });

    it('leaves the hold alone when the peak would stay under the top anyway', () => {
        const d = bandDecision(input(Object.assign({ projectedFc: 8 }, peak)));
        expect(d.pct).toBeCloseTo(21.33, 1);
        expect(d.peakCapped).toBe(false);
    });

    it('does nothing without a run window to work from', () => {
        const d = bandDecision(input({ projectedFc: 9.5, peakCap: true, peakRunHours: 0, peakDayEq: 0 }));
        expect(d.pct).toBeCloseTo(17.33, 1);
        expect(d.peakCapped).toBe(false);
    });

    it('does not touch a boost below the range', () => {
        const withCap = bandDecision(input(Object.assign({ projectedFc: 6, elapsedDays: 1 }, peak)));
        const without = bandDecision(input({ projectedFc: 6, elapsedDays: 1 }));
        expect(withCap.mode).toBe('boost');
        expect(withCap.pct).toBeCloseTo(without.pct, 6);
    });
});

describe('integral correction', () => {
    it('trims the hold down when the last readings sit above the middle of the range', () => {
        // readings at 9.5 against a middle of 8.5 and a half range of 1.5: 0.3 x (1 / 1.5) = 20% of the maintenance %
        const d = bandDecision(input({ integral: 0.3, recentReadings: [9.5, 9.5, 9.5] }));
        expect(d.integralTrim).toBeCloseTo(0.2, 5);
        expect(d.pct).toBeCloseTo(16, 3);
    });

    it('trims the hold up when the last readings sit below the middle of the range', () => {
        const d = bandDecision(input({ integral: 0.3, recentReadings: [7.5, 7.5, 7.5] }));
        expect(d.integralTrim).toBeCloseTo(-0.2, 5);
        expect(d.pct).toBeCloseTo(24, 3);
    });

    it('needs at least two readings, and uses only the last three', () => {
        expect(bandDecision(input({ integral: 0.3, recentReadings: [9.5] })).pct).toBeCloseTo(20, 5);
        const d = bandDecision(input({ integral: 0.3, recentReadings: [4, 4, 9.5, 9.5, 9.5] }));
        expect(d.pct).toBeCloseTo(16, 3);
    });

    it('is off when the gain is 0 or absent', () => {
        expect(bandDecision(input({ integral: 0, recentReadings: [9.5, 9.5, 9.5] })).pct).toBeCloseTo(20, 5);
        expect(bandDecision(input({ recentReadings: [9.5, 9.5, 9.5] })).pct).toBeCloseTo(20, 5);
    });
});
