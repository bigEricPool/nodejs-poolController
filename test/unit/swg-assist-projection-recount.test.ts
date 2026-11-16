// The History panel's projected FC points are worked out again with the cycle count from the power log's first line on (controller/AutoSwgProjection.ts:
// staleForRecount, withChlorCycle). Before the log nothing changes. A record made before the count has no chlorCycle in its inputs, so its replays take the
// chlorinator's current settings; on the real data that moves the projection at the 2026-11-14 test to what the projection accuracy page now shows.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { COUNT_VERSION, ProjectionPoint, staleForRecount, withChlorCycle } from '../../controller/AutoSwgProjection';
import { ArchivedHistory, LocalSwgEntry, computeRecommendation } from '../../controller/AutoSwgService';
import type { PowerEvent } from '../../controller/ChlorinatorUsage';

const H = 3600000;
const SINCE = Date.UTC(2026, 10, 8, 18, 38);
const pt = (kind: any, t: number, v?: number): ProjectionPoint => (v ? { t, fc: 9, kind, run: t, v } : { t, fc: 9, kind, run: t });

describe('staleForRecount', () => {
    it('drops the points from the power log on that were not worked out with the count; keeps those before it and those stamped', () => {
        const before = pt('hourly', SINCE - H), old = pt('hourly', SINCE + H), done = pt('hourly', SINCE + 2 * H, COUNT_VERSION);
        const after = pt('after', SINCE + 3 * H), reading = pt('reading', SINCE + 4 * H), lead = pt('lead', SINCE + 5 * H), beforeKind = pt('before', SINCE + 6 * H);
        expect(staleForRecount([before, old, done, after, reading, lead, beforeKind], SINCE, new Set())).toEqual([old, after, reading, lead, beforeKind]);
    });
    it('keeps a lead point at a test time (the test itself, not a calculation)', () => {
        const test = pt('lead', SINCE + H), hour = pt('lead', SINCE + 2 * H);
        expect(staleForRecount([test, hour], SINCE, new Set([SINCE + H]))).toEqual([hour]);
    });
    it('drops nothing without a power log', () => {
        expect(staleForRecount([pt('hourly', SINCE + H)], Infinity, new Set())).toEqual([]);
    });
});

describe('withChlorCycle', () => {
    const cyc = { id: 50, cycleHours: 3, restartsOnPower: true, burstFirst: true };
    it('gives a record without chlorCycle the current settings, leaves one that has them, and changes nothing without settings', () => {
        const inputs: any = { gallons: 12000 };
        expect(withChlorCycle(inputs, cyc)).toEqual({ gallons: 12000, chlorCycle: cyc });
        expect(inputs.chlorCycle).toBeUndefined();
        const own = { gallons: 12000, chlorCycle: { id: 50, cycleHours: 2, restartsOnPower: false, burstFirst: true } };
        expect(withChlorCycle(own, cyc)).toBe(own);
        expect(withChlorCycle(inputs, undefined)).toBe(inputs);
    });
});

describe('a replay of an old record on the real data', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'swg-cycle-count-real.json'), 'utf8'));
    const events: PowerEvent[] = fx.powerEvents.map((e: any) => ({ t: new Date(e.t).getTime(), on: e.on }));
    const local: LocalSwgEntry[] = fx.localSwg;
    const archive: ArchivedHistory = {
        fc: fx.archive.fc.map((x: any) => ({ ts: new Date(x.ts), value: x.value })),
        swg: fx.archive.swg.map((x: any) => ({ ts: new Date(x.ts), ppmPerDay: x.ppmPerDay, hrs: x.hrs, pct: x.pct })),
        cya: fx.archive.cya.map((x: any) => ({ ts: new Date(x.ts), value: x.value })),
        chlorine: fx.archive.chlorine.map((x: any) => ({ ts: new Date(x.ts), percent: x.percent, ml: x.ml })),
        temp: fx.archive.temp.map((x: any) => ({ ts: new Date(x.ts), value: x.value })),
    };
    const runs = fx.superChlorRuns.map((r: any) => ({ startMs: new Date(r.start).getTime(), endMs: new Date(r.end).getTime(), poweredHours: r.poweredHours }));
    const TEST = Date.parse('2026-11-14T15:17:29.000Z');   // the FC test of 10 ppm; the projection a minute before it is the History panel's `reading` point
    const replay = async (cyc: any) => {
        expect(fx.inputs.chlorCycle).toBeUndefined();         // the fixture's inputs are a record's, without the cycle settings
        const p = Object.assign({}, withChlorCycle(fx.inputs, cyc), { shareCode: 'fixture', powerEvents: events, superChlorRuns: runs, asOf: new Date(TEST - 60000) });
        return (await computeRecommendation(p, '<html><body></body></html>', local, undefined, archive)).projectedCurrentFc;
    };
    it('moves the projection at the 11-14 test from the old count to the cycle count (11.33, as the Pi\'s projection accuracy shows)', async () => {
        const old = await replay(undefined), recount = await replay(fx.chlorCycle);
        console.log(`\n11-14 15:17 test (10 ppm): projected ${old.toFixed(2)} by the run window, ${recount.toFixed(2)} by the cycle count`);
        expect(recount).toBeCloseTo(11.33, 1);
        expect(recount).toBeGreaterThan(old);
    });
});
