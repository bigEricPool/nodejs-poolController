// Cell usage counted by cycles (controller/ChlorinatorUsage.ts) on real data: a Nixie njsPC's chlorinator power log and output log from
// 2026-11-08 to 2026-11-16 (test/unit/fixtures/chlorinator-usage-real.json), a 3-hour cycle cell, current first, restarting at power-on.
// The reference is an independent 1-second step simulation of the same power log (referenceDaily, ppm per local day).
// Before the fix the count came to 3.86 ppm against the reference's 5.12, from two approximations:
// - the hour the power comes on each morning (and the one it goes off in) carries the overnight "communication lost" status and a stale
//   output age, so the whole hour was dropped, and with it the day's first on-period;
// - an hour split by an njsPC restart has two or three lines, each credited with the whole hour's cycles scaled by its share of samples,
//   which can come to more than the hour (or less).
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { CycleContext, CycleSettings, NOT_GENERATING, PowerEvent, cellUsageForHour, cellUsageFromInstall, cellUsageSince, cycleConduction, pctAtFromHours } from '../../controller/ChlorinatorUsage';
import type { ChlorinatorOutputHour } from '../../controller/ChlorinatorLog';

const H = 3600000, DAY = 24 * H;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chlorinator-usage-real.json'), 'utf8'));
const events: PowerEvent[] = fx.powerEvents.map((e: any) => ({ t: new Date(e.t).getTime(), on: e.on }));
const hours: ChlorinatorOutputHour[] = fx.outputHours;
const cycle: CycleSettings = fx.cycle;
const LBS: number = fx.cellLbsPerDay;
const PPM_PER_HOUR = LBS * 1e6 / (fx.gallons * 8.34) / 24;   // ppm from one full-output hour
const CAPTURED = new Date(fx.capturedAt).getTime();
const LOG_START = events[0].t;
const FIRST_WHOLE_HOUR = Math.ceil(LOG_START / H) * H;
const ctx: CycleContext = { cycle: cycle, events: events, since: LOG_START, pctAt: pctAtFromHours(hours) };

// local midnight of a day key in the fixture's time zone
const fmtHour = new Intl.DateTimeFormat('en-US', { timeZone: fx.timezone, hourCycle: 'h23', hour: '2-digit' });
const localMidnight = (day: string): number => { const g = new Date(`${day}T12:00:00Z`).getTime(); return g - Number(fmtHour.format(new Date(g))) * H - (new Date(g).getUTCMinutes()) * 60000; };
const dayKey = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: fx.timezone }).format(new Date(t));
const nextMidnight = (day: string) => localMidnight(dayKey(localMidnight(day) + 26 * H));

// The count before the fix, for the record: each line on its own, dropped for any NOT_GENERATING status or a stale age, else the whole
// hour's cycles times the share of the hour its samples cover.
function oldCount(from: number, to: number): number {
    let total = 0;
    for (const h of hours) {
        const t = new Date(h.t).getTime();
        if (t < from || t + H > to) continue;
        if (!(h.out > 0) || (typeof h.age === 'number' && h.age > 900) || (Array.isArray(h.st) && h.st.some(s => (s & NOT_GENERATING) !== 0))) continue;
        total += cycleConduction(events, t, t + H, cycle, ctx.pctAt) * Math.min(1, h.n / 6);
    }
    return total * PPM_PER_HOUR;
}

describe('cell usage by cycles: real data, 2026-11-08 to 2026-11-16', () => {
    const refTotal = fx.referenceDaily.reduce((s: number, d: any) => s + d.ppm, 0);

    it('reproduces the old undercount: 3.86 ppm against the reference 5.12', () => {
        expect(refTotal).toBeCloseTo(5.12, 2);
        expect(oldCount(LOG_START, CAPTURED)).toBeCloseTo(3.863, 3);
    });

    it('per day, matches the reference within 1% (the % comes from the output log, the reference\'s from the SWG % changes)', () => {
        const rows: string[] = ['', 'day         reference   cell usage'];
        let total = 0;
        for (const d of fx.referenceDaily) {
            const a = Math.max(localMidnight(d.day), FIRST_WHOLE_HOUR), b = Math.min(nextMidnight(d.day), CAPTURED);
            const dayHours = hours.filter(h => { const t = new Date(h.t).getTime(); return t >= a && t < b; });
            let ppm = cellUsageSince(dayHours, a, LBS, ctx, b).hours * PPM_PER_HOUR;
            // the minutes of the power log before its first whole hour: that hour starts before the log, so it is counted by its mean output
            if (localMidnight(d.day) <= LOG_START && LOG_START < nextMidnight(d.day)) ppm += cycleConduction(events, LOG_START, FIRST_WHOLE_HOUR, cycle, ctx.pctAt) * PPM_PER_HOUR;
            total += ppm;
            rows.push(`${d.day}  ${d.ppm.toFixed(4)}      ${ppm.toFixed(4)}`);
            if (d.ppm < 0.01) expect(ppm).toBeLessThan(0.01);
            else expect(Math.abs(ppm / d.ppm - 1)).toBeLessThan(0.01);
        }
        rows.push(`total       ${refTotal.toFixed(4)}      ${total.toFixed(4)}   (before the fix ${oldCount(LOG_START, CAPTURED).toFixed(4)})`);
        console.log(rows.join('\n'));
        expect(Math.abs(total / refTotal - 1)).toBeLessThan(0.005);
    });

    it('over the logged hours, the count is the cycles of the power log itself, each hour once', () => {
        const u = cellUsageSince(hours, FIRST_WHOLE_HOUR, LBS, ctx, CAPTURED);
        expect(u.hours).toBeCloseTo(cycleConduction(events, FIRST_WHOLE_HOUR, CAPTURED, cycle, ctx.pctAt), 9);
        expect(u.pounds).toBeCloseTo(u.hours * LBS / 24, 9);
        expect(u.cycleHourCount).toBe(new Set(hours.filter(h => h.n > 0 && new Date(h.t).getTime() >= FIRST_WHOLE_HOUR).map(h => h.t)).size);
        // the enabled time is at most one hour per clock hour
        expect(u.runHours).toBeLessThanOrEqual(u.cycleHourCount + 1e-9);
    });

    it('the recount from the install date gives the same, with the hour before the log by its mean output', () => {
        const installed = new Date('2026-11-08T00:00:00Z').getTime();
        const all = cellUsageFromInstall(hours, [], installed, CAPTURED, fx.gallons, LBS, ctx);
        const logged = cellUsageSince(hours, FIRST_WHOLE_HOUR, LBS, ctx, CAPTURED);
        const before = cellUsageSince(hours.filter(h => new Date(h.t).getTime() < FIRST_WHOLE_HOUR), installed, LBS, ctx);
        expect(all.hours).toBeCloseTo(logged.hours + before.hours, 9);
        expect(all.estimatedPounds).toBe(0);
    });

    it('the morning power-on hour counts the day\'s first on-period despite its "communication lost" status', () => {
        const h = hours.find(x => x.t === '2026-11-11T11:00:00.000Z');
        expect(h.st).toEqual([128]);
        const t = new Date(h.t).getTime();
        const u = cellUsageForHour(h, LBS, ctx);
        expect(u.cycle).toBe(true);
        expect(u.hours).toBeGreaterThan(0);
        expect(u.hours).toBeCloseTo(cycleConduction(events, t, t + H, cycle, ctx.pctAt), 12);
    });

    it('an hour split by restarts counts once: three lines, their spans add up to the hour', () => {
        const lines = hours.filter(x => x.t === '2026-11-13T12:00:00.000Z');
        expect(lines.length).toBe(3);
        const t = new Date(lines[0].t).getTime();
        const whole = cycleConduction(events, t, t + H, cycle, ctx.pctAt);
        expect(cellUsageSince(lines, t, LBS, ctx).hours).toBeCloseTo(whole, 12);
        // as the lines are written, each from where the count had reached: the two restarts in the hour, then the end of the hour
        const cuts = [t, events.find(e => !e.on && e.t > t).t, events.filter(e => !e.on && e.t > t)[1].t, t + H];
        let sum = 0;
        for (let i = 0; i < 3; i++) sum += cellUsageForHour(lines[i], LBS, ctx, [cuts[i], cuts[i + 1]]).hours;
        expect(sum).toBeCloseTo(whole, 12);
    });
});
