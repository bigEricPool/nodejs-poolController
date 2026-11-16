// Super chlorinate credited in SWG Assist's burn calculation (controller/AutoSwgService.ts, superChlorCredit): an 8 h run at 100% between two FC readings
// must give the same burn as no run, within rounding, and no suspect flag, whether or not PoolMath has the writer's 100% entry for it and with an apply
// during the run. The FC readings come from a small simulation of what the cell really made: the set % inside the run window, 100% during the run.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { AutoSwgParams, ArchivedHistory, LocalSwgEntry, computeRecommendation } from '../../controller/AutoSwgService';
import type { SuperChlorRun } from '../../controller/AutoSwgSuperChlor';

const H = 3600000, DAY = 24 * H;
const HTML = '<html><body></body></html>';   // no cards: the history comes from the archive
const GALLONS = 15000, LBS = 1.47;
const RATED = LBS * 1e6 / (GALLONS * 8.34);   // ppm per 24 h at 100%
const WIN_START = 7, WIN_HOURS = 10;           // 07:00-17:00 UTC
const BURN = 1.0;                              // ppm/day, even over the day (no daylight weighting)
const ppmPerDay = (pct: number) => RATED * (pct / 100) * (WIN_HOURS / 24);

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);     // first reading, noon
const READINGS = [T0, T0 + 2 * DAY, T0 + 4 * DAY, T0 + 6 * DAY];
const RUN = { startMs: T0 + 2 * DAY + 20 * H, endMs: T0 + 2 * DAY + 28 * H };
const DEFAULT_RUN = RUN;   // 08:00-16:00 on the day after the second reading

const base: AutoSwgParams = {
    shareCode: 'test', gallons: GALLONS, swgLbsPerDay: LBS, swgStartTime: '07:00', swgStopTime: '17:00', timezone: 'UTC',
    windowDays: 14, targetFc: 8, targetPeriodsAbove: 1, targetPeriodsBelow: 1,
    projectionWeight: 1, projectionTaperStartDays: 3, projectionTaperEndDays: 0, troughFloor: true,
};

// What the cell did: the set % (a step function of `sets`) in the run window, 100% while a run is on. Integrated in 6-minute steps.
function simulateFc(sets: { ts: number; pct: number }[], runs: { startMs: number; endMs: number }[], fc0: number, from: number, to: number): number {
    const step = H / 10;
    let fc = fc0;
    for (let t = from; t < to; t += step) {
        const mid = t + step / 2;
        let pct = 0;
        for (const s of sets) if (s.ts <= mid) pct = s.pct;
        const hourOfDay = ((mid % DAY) + DAY) % DAY / H;
        const inWindow = hourOfDay >= WIN_START && hourOfDay < WIN_START + WIN_HOURS;
        const inRun = runs.some(r => mid >= r.startMs && mid < r.endMs);
        const perHour = inRun ? RATED / 24 : (inWindow ? RATED * (pct / 100) / 24 : 0);
        fc += perHour * (step / H) - BURN / 24 * (step / H);
    }
    return fc;
}

// The history for a set % that starts at 20% (with an optional local apply), with or without the run, and with or without the writer's PoolMath pair.
function history(opts: { run: boolean; writerPair?: boolean; applyAt?: number; applyPct?: number; basePct?: number; span?: { startMs: number; endMs: number } }) {
    const basePct = typeof opts.basePct === 'number' ? opts.basePct : 20;
    const RUN = opts.span || DEFAULT_RUN;
    const sets: { ts: number; pct: number }[] = [{ ts: T0 - 5 * DAY, pct: basePct }];
    const local: LocalSwgEntry[] = [];
    if (typeof opts.applyAt === 'number') {
        sets.push({ ts: opts.applyAt, pct: opts.applyPct });
        local.push({ ts: new Date(opts.applyAt).toISOString(), pct: opts.applyPct, hrs: WIN_HOURS, ppmPerDay: ppmPerDay(opts.applyPct), kind: 'auto' });
    }
    const runs = opts.run ? [RUN] : [];
    const fc: { ts: Date; value: number }[] = [];
    let v = 8, t = READINGS[0];
    fc.push({ ts: new Date(t), value: v });
    for (const r of READINGS.slice(1)) { v = simulateFc(sets, runs, v, t, r); t = r; fc.push({ ts: new Date(r), value: v }); }
    const swg: ArchivedHistory['swg'] = [{ ts: new Date(T0 - 5 * DAY), pct: basePct, hrs: WIN_HOURS, ppmPerDay: ppmPerDay(basePct) }];
    if (opts.run && opts.writerPair) {
        // the writer's entries: 100% with runTime = the powered hours and Amount = the run's total FC, at the start; then the normal % at the end
        const poweredH = (RUN.endMs - RUN.startMs) / H;
        const endPct = typeof opts.applyAt === 'number' ? opts.applyPct : basePct;
        swg.push({ ts: new Date(RUN.startMs), pct: 100, hrs: poweredH, ppmPerDay: RATED * poweredH / 24 });
        swg.push({ ts: new Date(RUN.endMs), pct: endPct, hrs: WIN_HOURS, ppmPerDay: ppmPerDay(endPct) });
    }
    const archive: ArchivedHistory = { fc, swg, cya: [{ ts: new Date(T0), value: 70 }], chlorine: [] };
    const scRuns: SuperChlorRun[] = opts.run ? [{ startMs: RUN.startMs, endMs: RUN.endMs, poweredHours: (RUN.endMs - RUN.startMs) / H, reason: 'timer' }] : [];
    return { archive, local, scRuns };
}

// A tight suspect tolerance (0.5 ppm, default 2), so an uncredited run would be flagged.
async function calc(h: ReturnType<typeof history>, asOf: number, runs?: SuperChlorRun[], tolerance: number = 0.5) {
    return computeRecommendation(Object.assign({}, base, { asOf: new Date(asOf), superChlorRuns: runs || h.scRuns, fcAnomalyTolerancePpm: tolerance }), HTML, h.local, undefined, h.archive);
}
const AFTER = READINGS[READINGS.length - 1] + 60000;

describe('super chlorinate credit in the burn', () => {
    it('the history without a run burns what was simulated', async () => {
        const r = await calc(history({ run: false }), AFTER);
        expect(r.avgConsumptionPpmPerDay).toBeCloseTo(BURN, 2);
    });

    it('without the credit, a run reads as a too-low burn and a suspect interval (the bug)', async () => {
        const h = history({ run: true });
        const kept = await calc(h, AFTER, [], 2);          // the 3.1 ppm rise is within the default tolerance: kept, and the burn reads low
        expect(kept.avgConsumptionPpmPerDay).toBeLessThan(BURN - 0.3);
        const flagged = await calc(h, AFTER, []);
        expect(flagged.fcAnomalyNote).toBeDefined();
    });

    for (const writerPair of [false, true]) {
        it(`an 8 h run gives the same burn as no run, with no suspect flag (${writerPair ? 'with' : 'without'} the writer's PoolMath pair)`, async () => {
            const none = await calc(history({ run: false }), AFTER);
            const r = await calc(history({ run: true, writerPair }), AFTER);
            expect(Math.abs(r.avgConsumptionPpmPerDay - none.avgConsumptionPpmPerDay)).toBeLessThanOrEqual(0.01);
            expect(r.fcAnomalyNote).toBeUndefined();
            expect(r.superChlor).toBeDefined();
            expect(r.superChlor[0].poweredHours).toBe(8);
            expect(r.superChlor[0].fullPpm).toBeCloseTo(RATED * 8 / 24, 2);
            expect(r.rationale.some(x => /^Super chlorinate .*: \+3\.92 ppm credited \(8\.0 h at 100%/.test(x))).toBe(true);
        });
        it(`an apply during the run changes nothing either (${writerPair ? 'with' : 'without'} the writer's PoolMath pair)`, async () => {
            const applyAt = RUN.startMs + 2 * H, applyPct = 30;   // 10:00, inside the run
            const none = await calc(history({ run: false, applyAt, applyPct }), AFTER);
            const r = await calc(history({ run: true, writerPair, applyAt, applyPct }), AFTER);
            expect(Math.abs(r.avgConsumptionPpmPerDay - none.avgConsumptionPpmPerDay)).toBeLessThanOrEqual(0.01);
            expect(r.fcAnomalyNote).toBeUndefined();
        });
    }

    // The normal % makes chlorine only in the run window, so a run takes away the window hours' worth of it, not an even 24 h share: at 30%, an
    // 8 h run inside the window is credited (1 - 0.30) x the full rate per hour x 8, with or without the writer's PoolMath pair.
    for (const writerPair of [false, true]) {
        it(`an 8 h run at a normal 30% is credited (1 - 0.30) x full rate x 8 h (${writerPair ? 'with' : 'without'} the writer's pair)`, async () => {
            const none = await calc(history({ run: false, basePct: 30 }), AFTER);
            const r = await calc(history({ run: true, basePct: 30, writerPair }), AFTER);
            // creditPpm is what is credited on top of the SWG entries: with the writer's pair, its 100% entry already holds part of the run (its
            // Amount, the run's total, as a rate over the 8 h, less the normal rate), so the two together are the run's 2.74
            const heldByEntry = writerPair ? (RATED * 8 / 24 - ppmPerDay(30)) * 8 / 24 : 0;   // 0.82
            expect(r.superChlor[0].creditPpm + heldByEntry).toBeCloseTo((1 - 0.30) * (RATED / 24) * 8, 2);   // 2.74
            expect(Math.abs(r.avgConsumptionPpmPerDay - none.avgConsumptionPpmPerDay)).toBeLessThanOrEqual(0.01);
            expect(r.fcAnomalyNote).toBeUndefined();
        });
    }
    it('a run partly outside the run window: the hours outside get the full rate with nothing taken off', async () => {
        const span = { startMs: T0 + 2 * DAY + 25 * H, endMs: T0 + 2 * DAY + 33 * H };   // 13:00-21:00; the window ends at 17:00
        const none = await calc(history({ run: false, basePct: 30 }), AFTER);
        const r = await calc(history({ run: true, basePct: 30, span }), AFTER);
        expect(r.superChlor[0].creditPpm).toBeCloseTo((RATED / 24) * 8 - 0.30 * (RATED / 24) * 4, 2);   // 3.33
        expect(Math.abs(r.avgConsumptionPpmPerDay - none.avgConsumptionPpmPerDay)).toBeLessThanOrEqual(0.01);
    });
    it('a run with the cell powered for only part of it: the normal % is taken off for the powered hours only', async () => {
        const h = history({ run: true, basePct: 30 });
        const r = await calc(h, AFTER, [{ startMs: DEFAULT_RUN.startMs, endMs: DEFAULT_RUN.endMs, poweredHours: 6 }]);
        expect(r.superChlor[0].creditPpm).toBeCloseTo((1 - 0.30) * (RATED / 24) * 6, 2);   // 2.06
    });
    it('a 4-minute run (as in the 2026-11-16 live test) gets a few hundredths', async () => {
        const span = { startMs: T0 + 2 * DAY + 20 * H, endMs: T0 + 2 * DAY + 20 * H + 4 * 60000 };
        const r = await calc(history({ run: true, span }), AFTER);
        expect(r.superChlor[0].creditPpm).toBeCloseTo((1 - 0.20) * (RATED / 24) * (4 / 60), 2);   // 0.03
    });

    it('a run after the last reading is in the projection', async () => {
        // readings up to the second one only, then the run; the projection an hour after the run ends should be what the cell made
        const h = history({ run: true });
        const last = READINGS[1];
        const cut: ArchivedHistory = Object.assign({}, h.archive, { fc: h.archive.fc.filter(f => f.ts.getTime() <= last) });
        const asOf = RUN.endMs + H;
        const r = await computeRecommendation(Object.assign({}, base, { asOf: new Date(asOf), superChlorRuns: h.scRuns }), HTML, [], undefined, cut);
        const without = await computeRecommendation(Object.assign({}, base, { asOf: new Date(asOf), superChlorRuns: [] }), HTML, [], undefined, cut);
        const truth = simulateFc([{ ts: T0 - 5 * DAY, pct: 20 }], [RUN], cut.fc[cut.fc.length - 1].value, last, asOf);
        expect(Math.abs(r.projectedCurrentFc - truth)).toBeLessThanOrEqual(0.15);
        expect(r.projectedCurrentFc - without.projectedCurrentFc).toBeGreaterThan(2.5);   // 3.92 made less the 0.78 the 20% would have made in those 8 window hours
    });

    it('a run still on is credited up to the calculation time, and a past calculation sees only what had run by then', async () => {
        const h = history({ run: true });
        const mid = RUN.startMs + 4 * H;
        const cut: ArchivedHistory = Object.assign({}, h.archive, { fc: h.archive.fc.filter(f => f.ts.getTime() <= READINGS[1]) });
        const r = await computeRecommendation(Object.assign({}, base, { asOf: new Date(mid), superChlorRuns: h.scRuns }), HTML, [], undefined, cut);
        expect(r.superChlor[0].inProgress).toBe(true);
        expect(r.superChlor[0].poweredHours).toBeCloseTo(4, 2);
        expect(r.rationale.some(x => /now \(still on\)/.test(x))).toBe(true);
    });

    it('is not recorded in the inputs', async () => {
        const r = await calc(history({ run: true }), AFTER);
        expect(r.inputs.superChlorRuns).toBeUndefined();
    });
});
