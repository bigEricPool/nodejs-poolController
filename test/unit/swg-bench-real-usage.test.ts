// SWG Assist Model Bench, the cell's generation in the hourly inputs (controller/AutoSwgBenchModel.ts buildHourlyInputs) on real data: the
// Nixie njsPC's chlorinator power and output logs from 2026-11-08 to 2026-11-16 (test/unit/fixtures/chlorinator-usage-real.json, the base
// layer's fixture), a 3-hour cycle cell, current first, restarting at power-on.
// The base layer counts each clock hour of a cycle-counted cell once, from all its lines (an njsPC restart splits an hour into two or three
// lines). The bench must do the same: crediting each line with the whole hour's cycles would count a split hour two or three times.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { buildHourlyInputs, HOUR_MS, poundsToPpm } from '../../controller/AutoSwgBenchModel';
import { CycleContext, CycleSettings, PowerEvent, cellUsageForHour, cellUsageSince, cycleConduction, pctAtFromHours } from '../../controller/ChlorinatorUsage';
import type { ChlorinatorOutputHour } from '../../controller/ChlorinatorLog';

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chlorinator-usage-real.json'), 'utf8'));
const events: PowerEvent[] = fx.powerEvents.map((e: any) => ({ t: new Date(e.t).getTime(), on: e.on }));
const hours: ChlorinatorOutputHour[] = fx.outputHours;
const cycle: CycleSettings = fx.cycle;
const LBS: number = fx.cellLbsPerDay, GAL: number = fx.gallons;
const CAPTURED = new Date(fx.capturedAt).getTime();
const LOG_START = events[0].t;
const FIRST_WHOLE_HOUR = Math.ceil(LOG_START / HOUR_MS) * HOUR_MS;
const ctx: CycleContext = { cycle: cycle, events: events, since: LOG_START, pctAt: pctAtFromHours(hours) };
const ppm = (cellHours: number) => poundsToPpm(cellHours * LBS / 24, GAL);
const dayKey = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: fx.timezone }).format(new Date(t));

// the bench's inputs over the logged hours: whole hours from the first after the power log began to the capture
function benchRows() {
    return buildHourlyInputs({
        gallons: GAL, cellLbsPerDay: LBS, outputHours: hours, cycle: ctx,
        swgEntries: [], chlorine: [], weather: [], waterTemp: [], pump: [], salt: []
    }, FIRST_WHOLE_HOUR, Math.floor(CAPTURED / HOUR_MS) * HOUR_MS);
}

describe('bench hourly inputs: the cell counted by cycles on real data, 2026-11-08 to 2026-11-16', () => {
    it('an hour split by restarts (three lines) is counted once and matches the base\'s cellUsageSince', () => {
        const lines = hours.filter(x => x.t === '2026-11-13T12:00:00.000Z');
        expect(lines.length).toBe(3);
        const t = new Date(lines[0].t).getTime();
        const row = benchRows().find(r => r.t === t + HOUR_MS);
        const base = cellUsageSince(lines, t, LBS, ctx);
        expect(base.hours).toBeGreaterThan(0);
        expect(row.gen).toBeCloseTo(ppm(base.hours), 12);
        expect(row.gen).toBeCloseTo(ppm(cycleConduction(events, t, t + HOUR_MS, cycle, ctx.pctAt)), 12);
        // what the per-line sum would have given with the new base: the whole hour three times
        const perLine = lines.reduce((s, l) => s + ppm(cellUsageForHour(l, LBS, ctx).hours), 0);
        expect(perLine).toBeCloseTo(3 * row.gen, 9);
    });

    it('over the logged hours, the bench\'s generation is the base\'s count and the power log\'s cycles', () => {
        const rows = benchRows();
        const total = rows.reduce((s, r) => s + r.gen, 0);
        const end = rows[rows.length - 1].t;
        const base = cellUsageSince(hours.filter(h => new Date(h.t).getTime() + HOUR_MS <= end), FIRST_WHOLE_HOUR, LBS, ctx, end);
        expect(total).toBeCloseTo(ppm(base.hours), 9);
        expect(total).toBeCloseTo(ppm(cycleConduction(events, FIRST_WHOLE_HOUR, end, cycle, ctx.pctAt)), 9);
        expect(rows.every(r => r.genFrom === 'log' || r.gen === 0)).toBe(true);
    });

    // The capture day is left out of the comparison: the bench counts whole hours only, and the capture came 45 minutes into an hour.
    it('per local day, within 1% of the 1-second reference simulation (4.97 ppm over the complete days, 5.12 in all)', () => {
        const byDay = new Map<string, number>();
        for (const r of benchRows()) byDay.set(dayKey(r.t - HOUR_MS), (byDay.get(dayKey(r.t - HOUR_MS)) || 0) + r.gen);
        // the minutes of the power log before its first whole hour are not a bench hour (that hour starts before the log)
        const head = ppm(cycleConduction(events, LOG_START, FIRST_WHOLE_HOUR, cycle, ctx.pctAt));
        const lines: string[] = ['', 'day         reference   bench'];
        let total = 0, refTotal = 0, refAll = 0;
        for (const d of fx.referenceDaily) {
            let v = byDay.get(d.day) || 0;
            if (d.day === dayKey(LOG_START)) v += head;
            refAll += d.ppm;
            const captureDay = d.day === dayKey(CAPTURED);
            lines.push(`${d.day}  ${d.ppm.toFixed(4)}      ${v.toFixed(4)}${captureDay ? '   (capture day, to the last whole hour)' : ''}`);
            if (captureDay) continue;
            total += v; refTotal += d.ppm;
            if (d.ppm < 0.01) expect(v).toBeLessThan(0.01);
            else expect(Math.abs(v / d.ppm - 1)).toBeLessThan(0.01);
        }
        lines.push(`complete    ${refTotal.toFixed(4)}      ${total.toFixed(4)}`);
        console.log(lines.join('\n'));
        expect(refAll).toBeCloseTo(5.12, 2);
        expect(Math.abs(total / refTotal - 1)).toBeLessThan(0.005);
    });
});
