// Away protection with the Trip Maintenance Multiplier (AutoSwgParams.away.maintMultiplier, controller/AutoSwgService.ts): while Away is on, the % is the
// maintenance % as of the newest FC reading times the multiplier, held flat, with the storm or outage extra on top; no glide to the vacation target.
// Decided 2026-11-14 from a closed-loop trip sim: 2x the 14-day maintenance was as safe as the glide to Vacation Target 14 and far smoother.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { AutoSwgParams, ArchivedHistory, computeRecommendation } from '../../controller/AutoSwgService';

const DAY = 86400000;
const HTML = '<html><body></body></html>';   // no cards: the history comes from the archive
const SWG_PPM_PER_PCT = 3.2 / 100;

// FC tested every 2 days at noon UTC for 40 days, held at 8 by an SWG that makes what the pool burns: 1.0 ppm/day until 6 days before the last test,
// then 0.5. So the 14-day average at the last test mixes both, and as the window slides on with no new test, the live average falls toward 0.5.
function history(daysAgo = 12): { archive: ArchivedHistory; lastAt: number } {
    const today = new Date(); today.setUTCHours(12, 0, 0, 0);
    const lastAt = today.getTime() - (today.getTime() > Date.now() ? DAY : 0) - daysAgo * DAY;
    const startAt = lastAt - 40 * DAY, changeAt = lastAt - 6 * DAY;
    const fc: { ts: Date; value: number }[] = [];
    for (let t = startAt; t <= lastAt; t += 2 * DAY) fc.push({ ts: new Date(t), value: 8 });
    const swg = [
        { ts: new Date(startAt - 5 * DAY), pct: 1.0 / SWG_PPM_PER_PCT, hrs: 10, ppmPerDay: 1.0 },
        { ts: new Date(changeAt), pct: 0.5 / SWG_PPM_PER_PCT, hrs: 10, ppmPerDay: 0.5 },
    ];
    return { archive: { fc, swg, cya: [{ ts: new Date(startAt), value: 70 }], chlorine: [] }, lastAt };
}

const base: AutoSwgParams = {
    shareCode: 'test', gallons: 15000, swgLbsPerDay: 1.47, swgStartTime: '07:00', swgStopTime: '17:00', timezone: 'UTC',
    windowDays: 14, targetFc: 14, targetPeriodsAbove: 1, targetPeriodsBelow: 1,
    projectionWeight: 0.65, projectionTaperStartDays: 3, projectionTaperEndDays: 0, troughFloor: true,
    storm: { apply: true, maxExtraPct: 20 },
};
const away = (mult?: number) => Object.assign({}, base, { away: { active: true, normalTargetFc: 8.5, maintMultiplier: mult } });

describe('Away protection with the Trip Maintenance Multiplier', () => {
    const { archive, lastAt } = history();

    it('holds the maintenance % at the last reading times the multiplier, with no glide to the vacation target', async () => {
        const r = await computeRecommendation(Object.assign(away(2), { asOf: new Date(lastAt + 60000) }), HTML, [], undefined, archive);
        expect(r.awayFlat).toBeDefined();
        expect(r.awayFlat.multiplier).toBe(2);
        expect(r.awayFlat.maintenancePct).toBe(r.recommendedPct);                 // a minute after the reading, the live and at-reading averages agree
        expect(r.awayFlat.basePct).toBe(Math.round(r.awayFlat.maintenancePct * 2));
        expect(r.awayFlat.extraPct).toBe(0);
        expect(r.recommendedPctForTarget).toBe(r.awayFlat.basePct);
        expect(r.rationale.some(x => /Trip Maintenance Multiplier/.test(x))).toBe(true);
        // the glide to a vacation target of 14 from FC 8 would ask for far more
        const glide = await computeRecommendation(Object.assign(away(0), { asOf: new Date(lastAt + 60000) }), HTML, [], undefined, archive);
        expect(glide.awayFlat).toBeUndefined();
        expect(glide.recommendedPctForTarget).toBeGreaterThan(r.recommendedPctForTarget);
    });

    it('does not drift as the averaging window slides past the last reading', async () => {
        const first = await computeRecommendation(Object.assign(away(2), { asOf: new Date(lastAt + 60000) }), HTML, [], undefined, archive);
        const later = await computeRecommendation(Object.assign(away(2), { asOf: new Date(lastAt + 10 * DAY) }), HTML, [], undefined, archive);
        expect(later.recommendedPct).toBeLessThan(first.recommendedPct);           // the live maintenance % fell with the window
        expect(later.awayFlat.maintenancePct).toBe(first.awayFlat.maintenancePct);
        expect(later.awayFlat.basePct).toBe(first.awayFlat.basePct);
        expect(later.recommendedPctForTarget).toBe(first.recommendedPctForTarget);
    });

    it('is off with multiplier 0, unset, or Away protection off', async () => {
        const asOf = new Date(lastAt + 60000);
        const old = await computeRecommendation(Object.assign({}, base, { away: { active: true, normalTargetFc: 8.5 }, asOf }), HTML, [], undefined, archive);
        const zero = await computeRecommendation(Object.assign(away(0), { asOf }), HTML, [], undefined, archive);
        const off = await computeRecommendation(Object.assign({}, base, { away: { active: false, maintMultiplier: 2 }, asOf }), HTML, [], undefined, archive);
        expect(old.awayFlat).toBeUndefined();
        expect(zero.awayFlat).toBeUndefined();
        expect(off.awayFlat).toBeUndefined();
        expect(zero.recommendedPctForTarget).toBe(old.recommendedPctForTarget);
    });

    it('adds the outage extra on top of the flat %, within the cap', async () => {
        // The outage correction only acts on a live calculation (no asOf), so the last reading is about 4 days before now (stale), and njsPC was down
        // for the whole run window 2 days after it.
        const live = history(4);
        const outageDay = live.lastAt + 2 * DAY;
        const outages = [{ from: new Date(outageDay - 6 * 3600000).toISOString(), to: new Date(outageDay + 6 * 3600000).toISOString() }];
        const plain = await computeRecommendation(away(2), HTML, [], undefined, live.archive);
        const hit = await computeRecommendation(Object.assign(away(2), { outages }), HTML, [], undefined, live.archive);
        expect(hit.stormApplied).toBe(true);
        expect(hit.awayFlat.basePct).toBe(plain.awayFlat.basePct);
        expect(hit.awayFlat.extraPct).toBeGreaterThan(0);
        expect(hit.awayFlat.extraPct).toBeLessThanOrEqual(20);
        expect(hit.recommendedPctForTarget).toBeGreaterThan(plain.recommendedPctForTarget);
        const capped = await computeRecommendation(Object.assign(away(2), { outages, storm: { apply: true, maxExtraPct: 1 } }), HTML, [], undefined, live.archive);
        expect(capped.awayFlat.extraPct).toBeLessThanOrEqual(1);
        expect(capped.recommendedPctForTarget).toBeLessThanOrEqual(capped.awayFlat.basePct + 1);
    });
});
