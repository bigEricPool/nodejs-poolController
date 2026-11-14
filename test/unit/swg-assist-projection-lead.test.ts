// The History panel's projected FC line for a run that came from a new FC test starts at the test (not at the check that read it), and the run it replaced ends
// there (controller/AutoSwgProjection.ts leadWindows and clipSuperseded). The case that raised it: a test of 11.5 ppm on 2026-11-12 18:46, the check that used it on
// 2026-11-13 07:36, and the line of the 10:00 check running on past the test until then.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { ProjectionPoint, clipSuperseded, leadWindows } from '../../controller/AutoSwgProjection';

const run = (applied: string, readingTs: string, value: number) => ({ appliedAt: applied, outputs: { mostRecentFc: { ts: readingTs, value: value } } });
const HOUR = 3600000;

describe('leadWindows', () => {
    const r1 = run('2026-11-12T15:00:02.000Z', '2026-11-07T18:18:12.000Z', 9.5);     // the 10:00 check, from the Nov 7 test
    const r2 = run('2026-11-13T12:36:00.000Z', '2026-11-12T23:46:22.000Z', 11.5);    // the 07:36 check, from the 18:46 test
    const r3 = run('2026-11-13T15:00:02.000Z', '2026-11-12T23:46:22.000Z', 11.5);    // the 10:00 check, same test as r2

    it('gives a run that came from a new test its reading, value and the hours between the test and its apply', () => {
        const w = leadWindows([r1, r2], 0);
        expect(w).toHaveLength(1);
        expect(w[0].run).toBe(Date.parse('2026-11-13T12:36:00.000Z'));
        expect(w[0].readingT).toBe(Date.parse('2026-11-12T23:46:22.000Z'));
        expect(w[0].value).toBe(11.5);
        expect(w[0].hours[0]).toBe(Date.UTC(2026, 10, 13, 0));
        expect(w[0].hours[w[0].hours.length - 1]).toBe(Date.UTC(2026, 10, 13, 12));
        expect(w[0].hours).toHaveLength(13);
    });

    it('gives nothing to a run that used the same test as the run before it', () => {
        expect(leadWindows([r1, r2, r3], 0).map(x => x.run)).toEqual([Date.parse('2026-11-13T12:36:00.000Z')]);
    });

    it('gives nothing when the reading is not newer than the previous run\'s, is not before its own apply, is too far back, or the run is before `from`', () => {
        expect(leadWindows([r2, r1], 0)).toEqual([]);                                                   // an older reading
        expect(leadWindows([r1, run('2026-11-13T12:36:00.000Z', '2026-11-13T13:00:00.000Z', 10)], 0)).toEqual([]);   // reading after the apply
        expect(leadWindows([r1, run('2026-11-20T12:36:00.000Z', '2026-11-12T23:46:22.000Z', 11.5)], 0)).toEqual([]);   // 8 days back
        expect(leadWindows([r1, r2], Date.parse('2026-11-14T00:00:00.000Z'))).toEqual([]);              // before `from`
    });

    it('has no hours when the apply is within the hour of the test', () => {
        const w = leadWindows([r1, run('2026-11-12T23:55:00.000Z', '2026-11-12T23:46:22.000Z', 11.5)], 0);
        expect(w).toHaveLength(1);
        expect(w[0].hours).toEqual([]);
    });

    it('does not use the test time itself as an hourly point', () => {
        const w = leadWindows([r1, run('2026-11-13T03:30:00.000Z', '2026-11-13T00:00:00.000Z', 11.5)], 0);
        expect(w[0].hours[0]).toBe(Date.UTC(2026, 10, 13, 1));
    });
});

describe('clipSuperseded', () => {
    const p = (t: number, fc: number, kind: ProjectionPoint['kind'], run: number): ProjectionPoint => ({ t: t * HOUR, fc, kind, run: run * HOUR });
    // run 100: applied at 100, expected 9.4 then ~9.6; the test (11.5) is at 130; run 160 applied from that test.
    const points: ProjectionPoint[] = [
        p(100, 9.4, 'after', 100), p(110, 9.5, 'hourly', 100), p(120, 9.55, 'hourly', 100), p(130, 9.6, 'reading', 100), p(140, 9.6, 'hourly', 100), p(150, 9.6, 'hourly', 100), p(160, 9.6, 'before', 100),
        p(130, 11.5, 'lead', 160), p(140, 11.47, 'lead', 160), p(150, 11.43, 'lead', 160), p(160, 11.41, 'after', 160), p(170, 11.3, 'hourly', 160)
    ];

    it('ends the run in force at the test where the test replaced it, and keeps the new run from the test on', () => {
        const out = clipSuperseded(points);
        const of = (run: number) => out.filter(x => x.run === run * HOUR).map(x => x.t / HOUR);
        expect(of(100)).toEqual([100, 110, 120, 130]);                 // its reading point at the test stays; the later hourly points and the before are left out
        expect(of(160)).toEqual([130, 140, 150, 160, 170]);            // starts at the test
        expect(out.find(x => x.kind === 'reading')!.fc).toBe(9.6);     // what the old run expected at the test, to compare with the 11.5
    });

    it('returns the points unchanged when no run has lead points', () => {
        const plain = points.filter(x => x.kind !== 'lead');
        expect(clipSuperseded(plain)).toBe(plain);
    });

    it('leaves the points of earlier runs, and of a run with no later lead run, alone', () => {
        const more = [p(50, 9, 'after', 50), p(60, 9, 'hourly', 50), p(100, 9.2, 'before', 50), ...points, p(200, 11, 'after', 200), p(210, 10.9, 'hourly', 200)];
        const out = clipSuperseded(more);
        expect(out.filter(x => x.run === 50 * HOUR)).toHaveLength(3);
        expect(out.filter(x => x.run === 200 * HOUR)).toHaveLength(2);
    });
});
