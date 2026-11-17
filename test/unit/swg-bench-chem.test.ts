// SWG Assist Model Bench, the water balance: the PoolMath reader, CSI, the acid chemistry, the leveling-off pH model and its fit, the projection,
// the acid advice and the scores (controller/AutoSwgBenchChem.ts). Synthetic pools only, except the figures checked against the user's PoolMath log.
import { describe, expect, it } from 'vitest';
import { BenchHour, DAY_MS, HOUR_MS } from '../../controller/AutoSwgBenchModel';
import {
    acidAdvice, acidDoseFlOz, acidMolPerL, acidTaDrop, bestStrength, ChemContext, ChemData, chemFromEntries, chemSummary, co2BalancePh, csi,
    DEFAULT_CHEM_SETTINGS, fitPh, normalizeChemSettings, PH_VARIANTS, PhClockIndex, phError, phAfterAcid, phPairs, projectPh, scorePhTest, settleAt
} from '../../controller/AutoSwgBenchChem';

const T0 = Date.UTC(2026, 5, 1);
const day = (d: number) => T0 + d * DAY_MS;
const OZ = 29.5735;
const variant = (id: string) => PH_VARIANTS.find(v => v.id === id);
function rows(days: number): BenchHour[] {
    const out: BenchHour[] = [];
    for (let t = T0 + HOUR_MS; t <= day(days); t += HOUR_MS) out.push({ t: t, gen: 0, genFrom: 'none', frac: 1, clear: 0 });
    return out;
}
function context(data: Partial<ChemData>, days: number = 80): ChemContext {
    const d: ChemData = Object.assign({ ph: [], ta: [], ch: [], salt: [], bor: [], csi: [], cya: [], temp: [], acid: [], boric: [] }, data);
    return { data: d, gallons: 12000, cya: () => 90, dilution: () => 1, rows: rows(days), ppmPerHourAtFull: 0.1 };
}

describe('the PoolMath reader', () => {
    it('reads the tests, both acid strengths by chemical id, and boric acid', () => {
        const d = chemFromEntries([
            { type: 'testlog', ts: '2026-06-02T12:00:00Z', ph: 7.8, ta: 70, ch: 750, csi: -0.1, bor: 24, waterTemp: 28, waterTempUnits: 1 },
            { type: 'chemlog', ts: '2026-06-03T12:00:00Z', chemical: 14, unit: 4, amount: 32, normalizedAmount: 32 * OZ },
            { type: 'chemlog', ts: '2026-06-01T12:00:00Z', chemical: 16, unit: 4, amount: 16 },
            { type: 'chemlog', ts: '2026-06-04T12:00:00Z', chemical: 10, unit: 6, amount: 1, normalizedAmount: 453.6 },
            { type: 'chemlog', ts: '2026-06-04T12:00:00Z', chemical: 0, percent: 10, normalizedAmount: 3785 }
        ]);
        expect(d.ph).toEqual([{ t: Date.parse('2026-06-02T12:00:00Z'), v: 7.8 }]);
        expect(d.csi[0].v).toBe(-0.1);
        expect(d.temp[0].v).toBeCloseTo(82.4, 6);
        expect(d.acid.map(a => [a.chemical, a.percent, a.flOz])).toEqual([[16, 14.5, 16], [14, 31.45, 32]]);
        expect(d.boric.length).toBe(1);
    });
});

describe('the chemistry', () => {
    it('gives the CSI as PoolMath does', () => {
        // 2026-11-14: pH 8.0, TA 70, CH 750, CYA 90, salt 3200, borates 24, 76.9 F; PoolMath said 0.19
        expect(csi(8.0, 70, 750, 90, 3200, 24, 76.9)).toBeCloseTo(0.208, 3);
        expect(csi(8.0, 0, 750, 90, 3200, 24, 76.9)).toBeUndefined();
    });
    it('sizes an acid dose as the carbonate, CYA and borate buffers say', () => {
        // 1 fl oz of 31.45% in 12,000 gal takes out about 0.33 ppm of TA
        expect(acidTaDrop(OZ, 31.45, 12000)).toBeCloseTo(0.326, 3);
        // 2026-11-08: 32 fl oz at pH 8.0, TA 60, borates 24; the test after read 7.5
        expect(phAfterAcid(8.0, 60, 90, 24, acidMolPerL(32 * OZ, 31.45, 12000))).toBeCloseTo(7.49, 2);
        expect(phAfterAcid(8.0, 60, 90, 24, acidMolPerL(32 * OZ, 14.5, 12000))).toBeCloseTo(7.79, 2);
        const dose = acidDoseFlOz(8.2, 7.6, 70, 90, 24, 31.45, 12000);
        expect(dose).toBeGreaterThan(38);
        expect(dose).toBeLessThan(46);
        expect(acidDoseFlOz(7.5, 7.6, 70, 90, 24, 31.45, 12000)).toBe(0);
        // the strength that explains a drop
        expect(bestStrength(8.0, phAfterAcid(8.0, 60, 90, 24, acidMolPerL(32 * OZ, 31.45, 12000)), 32 * OZ, 60, 90, 24, 12000)).toBeCloseTo(31.45, 0);
    });
    it('finds the pH the water settles at with the air\'s CO2, higher with more carbonate alkalinity', () => {
        expect(co2BalancePh(70, 90, 24)).toBeCloseTo(7.95, 1);
        expect(co2BalancePh(50, 0, 0)).toBeCloseTo(8.17, 1);
        expect(co2BalancePh(100, 0, 0)).toBeGreaterThan(co2BalancePh(50, 0, 0));
        expect(co2BalancePh(70, 90, 0)).toBeLessThan(co2BalancePh(70, 0, 0));
    });
    it('counts a reading at the kit\'s top as 8.2 or above', () => {
        expect(phError(8.2, 8.4)).toBe(0);
        expect(phError(8.2, 8.0)).toBeCloseTo(0.2, 9);
        expect(phError(7.8, 8.0)).toBeCloseTo(-0.2, 9);
    });
});

describe('the leveling-off pH model', () => {
    // a pair of tests two days apart every 2.4 days from day 2, each made by the model itself with c 0.2 and r 0.3 a day; between pairs the pH steps
    // down within 0.4 days (too close together to be a pair)
    function pool(c: number, r: number, n: number) {
        const ctx = context({ ta: [{ t: day(0), v: 70 }], bor: [{ t: day(0), v: 24 }], ch: [{ t: day(0), v: 400 }], acid: [{ t: day(1), ml: 1, percent: 31.45, flOz: 0, chemical: 14 }] });
        const clocks = new PhClockIndex(ctx.rows, ctx.ppmPerHourAtFull);
        for (let k = 0; k < n; k++) {
            const t1 = day(2 + 2.4 * k), t2 = t1 + 2 * DAY_MS;
            const p1 = 7.3 + 0.1 * (k % 4);
            const E = settleAt(ctx, (t1 + t2) / 2) + c;
            ctx.data.ph.push({ t: t1, v: p1 }, { t: t2, v: Math.round((E - (E - p1) * Math.exp(-r * 2)) * 1000) / 1000 });
        }
        return { ctx, clocks };
    }
    it('fits the offset and the rate from the pairs, and the data takes over from the priors', () => {
        const p = pool(0.2, 0.3, 24);
        const pairs = phPairs(p.ctx, day(80));
        expect(pairs.length).toBe(24);
        const f = fitPh(variant('ph-const'), pairs, p.clocks, Object.assign({}, DEFAULT_CHEM_SETTINGS, { priorPairs: 0 }));
        expect(Math.abs(f.c - 0.2)).toBeLessThan(0.02);
        expect(Math.abs(f.r / 0.3 - 1)).toBeLessThan(0.1);
        expect(f.rmse).toBeLessThan(0.02);
        // with only three pairs the priors (c 0) hold it back
        const few = fitPh(variant('ph-const'), pairs.slice(0, 3), p.clocks, DEFAULT_CHEM_SETTINGS);
        expect(Math.abs(few.c)).toBeLessThan(0.2);
        // fewer than three: the priors alone
        expect(fitPh(variant('ph-const'), pairs.slice(0, 2), p.clocks).prior).toBe(true);
    });
    it('leaves out pairs with acid between them and before acid logging began', () => {
        const ctx = context({
            ph: [{ t: day(1), v: 7.6 }, { t: day(3), v: 7.8 }, { t: day(5), v: 7.9 }, { t: day(7), v: 7.5 }, { t: day(9), v: 7.7 }],
            acid: [{ t: day(4), ml: 30 * OZ, percent: 31.45, flOz: 30 }], ta: [{ t: day(0), v: 70 }]
        });
        // day 1 is before the first logged acid less a day; the day 3 -> 5 pair has the dose; day 5 -> 7 fell 0.4 (unlogged acid)
        expect(phPairs(ctx, day(10)).map(p => [p.t1, p.t2])).toEqual([[day(7), day(9)]]);
        expect(phPairs(context({ ph: ctx.data.ph }), day(10))).toEqual([]);
    });
    it('weights the recent pairs', () => {
        const p = pool(0.2, 0.3, 24);
        const pairs = phPairs(p.ctx, day(65), Object.assign({}, DEFAULT_CHEM_SETTINGS, { recentDays: 20 }));
        const recent = pairs.filter(x => x.w === 3);
        expect(recent.length).toBeGreaterThan(0);
        expect(recent.every(x => x.t2 >= day(45))).toBe(true);
        expect(pairs.filter(x => x.w === 1).every(x => x.t2 < day(45))).toBe(true);
    });
    it('fits the baselines', () => {
        const p = pool(0.2, 0.3, 24);
        const pairs = phPairs(p.ctx, day(80));
        expect(fitPh(variant('ph-hold'), pairs, p.clocks).r).toBeUndefined();
        const lin = fitPh(variant('ph-linear60'), pairs, p.clocks);
        expect(lin.rate).toBeGreaterThan(0);
    });
    it('projects the rise and each dose\'s drop', () => {
        const ctx = context({ ta: [{ t: day(0), v: 60 }], bor: [{ t: day(0), v: 24 }], acid: [{ t: day(10) + HOUR_MS, ml: 32 * OZ, percent: 31.45, flOz: 32 }] });
        const clocks = new PhClockIndex(ctx.rows, 0.1);
        const hold = projectPh(ctx, variant('ph-hold'), { id: 'ph-hold', kind: 'hold', n: 0, nRecent: 0 }, clocks, day(10), 8.0, [day(10) + 2 * HOUR_MS]);
        expect(hold[0]).toBeCloseTo(7.49, 2);
        // the taper never passes the level it settles at, and a dose after acidUpTo is not known
        const fit = { id: 'ph-const', kind: 'taper' as const, r: 0.3, c: 0.1, n: 10, nRecent: 0 };
        const E = settleAt(ctx, day(1)) + 0.1;
        const up = projectPh(ctx, variant('ph-const'), fit, clocks, day(1), 7.4, [day(2), day(5), day(9)]);
        expect(up[0]).toBeGreaterThan(7.4);
        expect(up[2]).toBeLessThan(E);
        expect(up[1]).toBeCloseTo(E - (E - 7.4) * Math.exp(-0.3 * 4), 2);
        const unknown = projectPh(ctx, variant('ph-const'), fit, clocks, day(9), 7.8, [day(11)], day(10));
        const known = projectPh(ctx, variant('ph-const'), fit, clocks, day(9), 7.8, [day(11)]);
        expect(unknown[0]).toBeGreaterThan(known[0] + 0.3);
    });
});

describe('the acid advice', () => {
    const now = day(30);
    const fit = { id: 'ph-const', kind: 'taper' as const, r: 0.4, c: 0.3, n: 20, nRecent: 10 };
    // the settling level is about 7.95 at TA 70 and 7.83 at TA 60 (CYA 90, borates 24), so 8.25 and 8.13 with c 0.3
    const at = (ph: number, ch: number = 400, ta: number = 70, f = fit) => {
        const ctx = context({ ph: [{ t: now - DAY_MS, v: ph }], ta: [{ t: day(0), v: ta }], ch: [{ t: day(0), v: ch }], bor: [{ t: day(0), v: 24 }] });
        return acidAdvice(ctx, variant('ph-const'), f, new PhClockIndex(ctx.rows, 0.1), now, DEFAULT_CHEM_SETTINGS, t => new Date(t).toISOString().slice(0, 10));
    };
    it('recommends acid when the pH is projected to reach 8.0 within three days, with a dose to 7.6', () => {
        const a = at(7.85);
        expect(a.level).toBe('recommended');
        expect(a.reason).toContain('pH');
        expect(a.doseTo).toBe(7.6);
        expect(a.doseFlOz).toBeGreaterThan(0);
        expect(a.taDrop).toBeGreaterThan(0);
        expect(a.doseStrength).toBe(31.45);
        // the dose is for when the pH reaches 8.0; today's, from the pH projected now, is smaller, and the words say both
        expect(a.doseNowFlOz).toBeLessThanOrEqual(a.doseFlOz);
        expect(a.doseNowFlOz).toBeGreaterThan(0);
        expect(a.doseFromPh).toBeGreaterThanOrEqual(8.0);
        expect(a.text).toMatch(/^pH projected to reach 8\.0 around 2026-0\d-\d\d; then add about \d+ fl oz of 31\.45% muriatic acid to bring it to 7\.6 \(about \d+ fl oz if added today\)\.$/);
    });
    it('says acid is needed at 8.2, and doses only to 7.8 when TA is 60 or less', () => {
        const a = at(8.2, 400, 60, Object.assign({}, fit, { c: 0.5 }));
        expect(a.level).toBe('needed');
        expect(a.doseTo).toBe(7.8);
        // reached now: one dose, from the pH now
        expect(a.doseFlOz).toBe(a.doseNowFlOz);
        expect(a.text).toMatch(/^pH projected at 8\.\d\d now; add about \d+ fl oz of 31\.45% muriatic acid to bring it to 7\.8\.$/);
    });
    it('goes by the CSI when CH is high', () => {
        // CH 1500: the CSI reaches 0.6 in about two days while the pH stays under 8.2
        const a = at(7.85, 1500);
        expect(a.level).toBe('needed');
        expect(a.reason).toContain('CSI');
        expect(a.text).toMatch(/^CSI projected to reach \+0\.60 around /);
    });
    it('gives no advice while the pH and CSI stay low', () => {
        const ctx = context({ ph: [{ t: now - DAY_MS, v: 7.3 }], ta: [{ t: day(0), v: 70 }], ch: [{ t: day(0), v: 300 }] });
        const a = acidAdvice(ctx, variant('ph-const'), Object.assign({}, fit, { r: 0.05, c: 0 }), new PhClockIndex(ctx.rows, 0.1), now);
        expect(a.level).toBe('none');
        expect(a.doseFlOz).toBeUndefined();
    });
    it('reads the settings with bounds', () => {
        const s = normalizeChemSettings({ phRecommended: 9, phNeeded: 7.9, main: 'ph-hold', csiNeeded: 0.4 });
        expect(s.phRecommended).toBe(8.4);
        expect(s.phNeeded).toBe(8.4);
        expect(s.main).toBe('ph-const');
        expect(s.csiNeeded).toBe(0.4);
    });
});

describe('the scores', () => {
    it('scores a pH test from the one before, flags a dose between them, and summarizes', () => {
        const ctx = context({
            ph: [{ t: day(1), v: 7.6 }, { t: day(3), v: 7.8 }, { t: day(5), v: 7.5 }], csi: [{ t: day(3), v: -0.2 }],
            ta: [{ t: day(0), v: 70 }], ch: [{ t: day(0), v: 400 }], acid: [{ t: day(4), ml: 20 * OZ, percent: 31.45, flOz: 20 }]
        });
        const clocks = new PhClockIndex(ctx.rows, 0.1);
        const hold = { id: 'ph-hold', kind: 'hold' as const, n: 0, nRecent: 0 };
        const r1 = scorePhTest(ctx, variant('ph-hold'), hold, clocks, 1, day(0.5), false);
        expect(r1.map(r => r.what)).toEqual(['ph', 'csi']);
        expect(r1[0].miss).toBeCloseTo(0.2, 6);
        expect(r1[0].flags).toBeUndefined();
        const r2 = scorePhTest(ctx, variant('ph-hold'), hold, clocks, 2, day(2.5), true);
        expect(r2[0].flags).toEqual(['acid']);
        expect(r2[0].replay).toBe(true);
        const sum = chemSummary(r1.concat(r2).filter(r => r.what === 'ph'));
        expect(sum.n).toBe(2);
        expect(sum.acid.n).toBe(1);
    });
});
