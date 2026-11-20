// SWG Assist Model Bench, 2026-11-20: the water balance (rain dilutes, evaporation concentrates, the local water log, spills), the FC dilution in the
// projections, the saved weather forecast, the stabilizer ramp ended by a test, and the salt rows. Synthetic pools only.
import { describe, expect, it } from 'vitest';
import { BenchHour, BenchVariant, DAY_MS, dilutionLoss, fitVariant, HOUR_MS, Interval, intervalDilution, plainRate, projectLoss, syncLiveRows } from '../../controller/AutoSwgBenchModel';
import { balanceFactor, evaporationInPerHour, hourFactor, meanDepthInches, normalizeWaterEvent, normalizeWaterSettings, waterBalance } from '../../controller/AutoSwgBenchWater';
import { cyaPath, Dilution, normalizeCyaSettings } from '../../controller/AutoSwgBenchCya';
import { FORECAST_MAX_AGE_MS, forecastFor, openMeteoUrl, parseOpenMeteo } from '../../controller/AutoSwgBenchForecast';

const T0 = Date.UTC(2026, 10, 1);
const day = (d: number) => T0 + d * DAY_MS;
function rows(days: number, f?: (r: BenchHour, i: number) => void): BenchHour[] {
    const out: BenchHour[] = [];
    for (let t = T0 + HOUR_MS, i = 0; t <= day(days); t += HOUR_MS, i++) {
        const r: BenchHour = { t: t, gen: 0, genFrom: 'none', frac: 1, clear: 0, sun: 0, rain: 0 };
        if (f) f(r, i);
        out.push(r);
    }
    return out;
}
const D = 51;   // the user's pool: 12,000 gal over 377 ft2

describe('evaporation', () => {
    it('is about 0.2 in a day for a warm pool in humid Florida air, more with wind, none over saturated cooler air', () => {
        const perDay = evaporationInPerHour(76, 72, 75, 1) * 24;
        expect(perDay).toBeGreaterThan(0.12); expect(perDay).toBeLessThan(0.3);
        expect(evaporationInPerHour(76, 72, 75, 5)).toBeGreaterThan(evaporationInPerHour(76, 72, 75, 1));
        expect(evaporationInPerHour(70, 75, 100, 0)).toBe(0);
    });
    it('the mean depth comes from the gallons and the area', () => {
        expect(meanDepthInches(12000, 377)).toBeCloseTo(51.07, 1);
        expect(meanDepthInches(0, 377)).toBe(0);
    });
});

describe('water balance', () => {
    it('rain dilutes by depth / (depth + inches), evaporation concentrates', () => {
        const r = rows(3, (x, i) => { if (i === 10) x.rain = 1; });
        const b = waterBalance(r, D, normalizeWaterSettings({ evapScale: 0 }));
        expect(balanceFactor(b, day(0), day(3))).toBeCloseTo(D / (D + 1), 6);
        expect(b.level[b.level.length - 1]).toBeCloseTo(1, 6);
        const dry = rows(10, x => { x.air = 75; x.rh = 70; x.wind = 1; x.temp = 78; });
        const e = waterBalance(dry, D, normalizeWaterSettings({}));
        const evap = e.evap.reduce((s, x) => s + x, 0);
        expect(evap).toBeGreaterThan(1);
        expect(balanceFactor(e, day(0), day(10))).toBeCloseTo(D / (D - evap), 4);
    });
    it('removing water lowers the level only; adding water dilutes', () => {
        const r = rows(4);
        const b = waterBalance(r, D, normalizeWaterSettings({ evapScale: 0 }), [{ t: day(1), kind: 'remove', inches: 2 }, { t: day(2), kind: 'add', inches: 2 }]);
        expect(balanceFactor(b, day(0), day(1.5))).toBeCloseTo(1, 9);
        expect(balanceFactor(b, day(1.5), day(3))).toBeCloseTo((D - 2) / D, 6);
        expect(b.level[b.level.length - 1]).toBeCloseTo(0, 6);
    });
    it('spills above the deck without changing a concentration', () => {
        const r = rows(2, (x, i) => { if (i === 5) x.rain = 8; });
        const b = waterBalance(r, D, normalizeWaterSettings({ evapScale: 0 }), [], { spillInches: 5 });
        expect(Math.max(...Array.from(b.level))).toBe(5);
        expect(b.spilled.reduce((s, x) => s + x, 0)).toBeCloseTo(3, 6);
        expect(balanceFactor(b, day(0), day(2))).toBeCloseTo(D / (D + 8), 6);
    });
    it('a storm\'s runoff multiplier counts in the balance (through Dilution)', () => {
        const r = rows(3, (x, i) => { if (i === 10) x.rain = 1; });
        const d = new Dilution(r);
        d.setBalance(D, normalizeWaterSettings({ evapScale: 0 }), []);
        expect(d.factor(day(0), day(3), 'rain', 0.02)).toBeCloseTo(D / (D + 1), 6);
    });
    it('normalizes water log entries', () => {
        expect(normalizeWaterEvent({ t: '2026-11-16T12:00:00Z', kind: 'add', inches: 1 })!.inches).toBe(1);
        expect(normalizeWaterEvent({ t: 'x', kind: 'add', inches: 1 })).toBeUndefined();
        expect(normalizeWaterEvent({ t: day(1), kind: 'fill', inches: 1 })).toBeUndefined();
        expect(normalizeWaterEvent({ t: day(1), kind: 'remove', inches: 0 })).toBeUndefined();
    });
});

describe('FC dilution in the projections', () => {
    const v: BenchVariant = { id: 'm', version: 1, kind: 'model', sun: 'none', fcTerm: 'fc', fitDays: 30, ridge: 0, fcPath: 'model', dilution: true, minIntervals: 3 };
    it('takes FC x (1 - factor) each hour, giving FC back under evaporation', () => {
        const r = rows(2, (x, i) => { x.dil = i === 5 ? 0.98 : 1; });
        expect(dilutionLoss(r, day(0), day(2), () => 10)).toBeCloseTo(0.2, 6);
        const e = rows(1, x => { x.dil = 1.001; });
        expect(dilutionLoss(e, day(0), day(1), () => 10)).toBeCloseTo(-0.24, 6);
    });
    it('is taken out before the fit, so the fitted burn is the burn alone', () => {
        // a steady 1 ppm a day, and 2% of the water replaced on day 10
        const r = rows(30, (x, i) => { x.dil = i === 10 * 24 ? 0.98 : 1; });
        const ivs: Interval[] = [];
        for (let k = 0; k < 29; k++) {
            const t1 = day(k) + 1, t2 = day(k + 1);
            const f1 = 10, gen = 1 + 0.2 * (t1 < day(10) && day(10) <= t2 ? 1 : 0);
            ivs.push({ t1: t1, f1: f1, t2: t2, f2: f1, gen: gen });
        }
        const fit = fitVariant(v, ivs, r, [], day(30))!;
        expect(fit.b).toBeCloseTo(1, 1);
        // the projection over the rain day adds the dilution back
        const p = projectLoss(v, fit, r, [], day(9), day(9) + 1, 10, day(11));
        const without = projectLoss(Object.assign({}, v, { dilution: false }), fit, r, [], day(9), day(9) + 1, 10, day(11));
        // 2% of the FC at the rain hour: the projected FC has burned down from 10 to about 9 by then
        expect(p! - without!).toBeCloseTo(0.02 * 9, 2);
    });
    it('the plain average net of dilution', () => {
        const r = rows(14, (x, i) => { x.dil = i === 24 ? 0.98 : 1; });
        const ivs: Interval[] = [{ t1: day(0), f1: 10, t2: day(14), f2: 10, gen: 14.2 }];
        expect(plainRate(ivs, day(14), 14)).toBeCloseTo(14.2 / 14, 6);
        expect(plainRate(ivs, day(14), 14, iv => intervalDilution(iv, r))).toBeCloseTo(14 / 14, 6);
    });
    it('a live row with dilution keeps its adjustment when the projection point is worked out again', () => {
        const rs: any[] = [{ t: day(3), mode: 'live', test: 8, proj: 9.5, miss: -1.5, days: 2, f1: 10, adj: -0.5 }];
        expect(syncLiveRows(rs, [{ t: day(3), fc: 9.2 }], { maxGapDays: 10, minCoverage: 0.9, minGapN: 8 })).toBe(1);
        expect(rs[0].proj).toBeCloseTo(8.7, 6);
        expect(rs[0].liveWas).toBe(9.5);
    });
});

describe('saved weather forecast', () => {
    it('asks Open-Meteo at the place rounded to 0.1 degree', () => {
        const u = openMeteoUrl(28.5234, -81.5401);
        expect(u).toContain('latitude=28.5&longitude=-81.5');
        expect(u).toContain('precipitation_unit=inch');
    });
    it('reads the hourly answer, with missing values as null', () => {
        const h = parseOpenMeteo({ hourly: { time: [1795000000], shortwave_radiation: [400], precipitation: [0.1], temperature_2m: [80], relative_humidity_2m: [70], wind_speed_10m: [null] } });
        expect(h).toEqual([[1795000000000, 400, 0.1, 80, 70, null]]);
        expect(parseOpenMeteo({})).toEqual([]);
    });
    it('uses the forecast\'s sun, rain and dilution in a forecast projection', () => {
        const v: BenchVariant = { id: 'm', version: 1, kind: 'model', sun: 'station', fcTerm: 'fc', fcPath: 'held', dilution: true, rainWash: true };
        const r = rows(1, x => { x.clear = 500; x.sun = 100; x.dil = 1; x.rain = 0; });
        const snap = { t: day(0), src: 'test', hours: r.map(x => [x.t, 300, 0.1, 75, 90, 0] as any) };
        const f = forecastFor(snap, 0.5, D, 76)!;
        expect(f.hours!.get(r[0].t)!.rain).toBe(0.1);
        expect(f.hours!.get(r[0].t)!.dil).toBeLessThan(1);
        const fit = { a: 1, b: 0, n: 5, b2: 0.2 };
        const withF = projectLoss(v, fit, r, [], day(0), day(0), 10, day(1), f)!;
        const clearOnly = projectLoss(v, fit, r, [], day(0), day(0), 10, day(1), 0.5)!;
        // the forecast's sun (300 against 250 from the clearness), its rain wash-in and its dilution
        expect(withF).toBeGreaterThan(clearOnly + 24 * 0.1 * 0.2);
        expect(hourFactor(D, 1, 0)).toBeCloseTo(D / (D + 1), 9);
        expect(FORECAST_MAX_AGE_MS).toBeGreaterThan(12 * HOUR_MS);
    });
});

describe('stabilizer ramp ended by a test', () => {
    it('a test one day into the ramp takes the addition as all in, with no overshoot after it', () => {
        // the 2026-10-31 case: 40, +30 logged, 90 a day later
        const s = Object.assign(normalizeCyaSettings({}), { rainK: 0, lossLow: 0, lossHigh: 0, rampDays: 5 });
        const p = cyaPath([{ t: day(0), ppm: 40 }, { t: day(1), ppm: 90 }], [{ t: day(0) + HOUR_MS, ppm: 30 }], rows(14), s, day(14));
        expect(p.at(day(1))).toBeCloseTo(90, 0);
        expect(p.at(day(5))).toBeCloseTo(90, 0);
        expect(p.at(day(13))).toBeCloseTo(90, 0);
    });
    it('an addition with no test after it still ramps over the full days', () => {
        const s = Object.assign(normalizeCyaSettings({}), { rainK: 0, lossLow: 0, lossHigh: 0, rampDays: 5 });
        const p = cyaPath([{ t: day(0), ppm: 40 }], [{ t: day(1), ppm: 30 }], rows(14), s, day(14));
        expect(p.at(day(3.5))).toBeCloseTo(55, 0);
        expect(p.at(day(10))).toBeCloseTo(70, 0);
    });
});

describe('FC projection lines for the History panel', () => {
    it('traces the model projection hour by hour, and carries the rows ahead with yesterday\'s chlorine', async () => {
        const { extendRows, plainPath } = await import('../../controller/AutoSwgBenchModel');
        const { fcRunPoints } = await import('../../controller/AutoSwgBenchHistorySource');
        const r = rows(2, x => { x.gen = 0.05; x.dil = 1; });
        const ext = extendRows(r, day(3));
        expect(ext.length).toBe(r.length + 24);
        expect(ext[ext.length - 1].gen).toBe(0.05);
        expect(ext[ext.length - 1].sun).toBeUndefined();
        const v: BenchVariant = { id: 'm', version: 1, kind: 'model', sun: 'none', fcTerm: 'fc', fcPath: 'model' };
        const pts: [number, number][] = [];
        projectLoss(v, { a: 0, b: 2.4, n: 5 }, r, [], day(0), day(0), 10, day(1), undefined, (t, fc) => pts.push([t, fc]));
        expect(pts.length).toBe(24);
        expect(pts[23][1]).toBeCloseTo(10 + 24 * 0.05 - 2.4, 6);
        const pp: [number, number][] = [];
        plainPath({ id: 'p', version: 1, kind: 'plain', dilution: true }, 2.4, ext, day(2), 10, day(3), () => 0.999, (t, fc) => pp.push([t, fc]));
        expect(pp.length).toBe(24);
        expect(pp[23][1]).toBeLessThan(10 + 24 * 0.05 - 2.4);
        expect(fcRunPoints([{ run: 5, points: [[day(1), 9], [day(9), 8]] }], day(0), day(2))).toEqual([{ t: day(1), v: 9, seg: 5 }]);
    });
});
