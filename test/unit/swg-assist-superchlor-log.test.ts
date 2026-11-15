// The super chlorinate run reader for SWG Assist (controller/AutoSwgSuperChlor.ts): pairs the on and off lines of data/chlorinatorSuperChlorLog.jsonl, and
// counts the powered hours from the output log when the off line has none.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { clearSuperChlorCache, parseSuperChlorLog, poweredHoursFromOutput, readSuperChlorRuns } from '../../controller/AutoSwgSuperChlor';

const H = 3600000;
const T0 = Date.UTC(2026, 10, 16, 13, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const lines = (xs: any[]) => xs.map(x => JSON.stringify(x)).join('\n') + '\n';

describe('parseSuperChlorLog', () => {
    it('pairs each on with the next off and keeps the powered hours and reason', () => {
        const runs = parseSuperChlorLog(lines([
            { t: iso(T0), id: 1, on: true },
            { t: iso(T0 + 8 * H), id: 1, on: false, reason: 'timer', poweredHours: 7.5 },
        ]));
        expect(runs).toEqual([{ startMs: T0, endMs: T0 + 8 * H, poweredHours: 7.5, reason: 'timer', id: 1 }]);
    });
    it('an on with no off is a run in progress; a stray off and a repeated on are ignored', () => {
        const runs = parseSuperChlorLog(lines([
            { t: iso(T0 - 2 * H), id: 1, on: false },
            { t: iso(T0), id: 1, on: true },
            { t: iso(T0 + H), id: 1, on: true },
        ]) + '{"t":"2026-11-16T2');   // a torn last line
        expect(runs.length).toBe(1);
        expect(runs[0].startMs).toBe(T0);
        expect(runs[0].endMs).toBeUndefined();
    });
    it('caps the powered hours at the length of the run, and skips spa runs', () => {
        const runs = parseSuperChlorLog(lines([
            { t: iso(T0), on: true, body: 1 }, { t: iso(T0 + 2 * H), on: false, body: 1 },
            { t: iso(T0 + 3 * H), on: true }, { t: iso(T0 + 5 * H), on: false, poweredHours: 9 },
        ]));
        expect(runs.length).toBe(1);
        expect(runs[0].poweredHours).toBe(2);
    });
});

describe('powered hours from the output log', () => {
    const out = [
        { t: iso(T0 - H), n: 6, on: 6, out: 40, max: 40, tgt: 40 },     // before: normal %
        { t: iso(T0), n: 6, on: 6, out: 100, max: 100, tgt: 100 },
        { t: iso(T0 + H), n: 6, on: 3, out: 50, max: 100, tgt: 100 },   // the cell lost power half the hour
        { t: iso(T0 + 2 * H), n: 6, on: 6, out: 100, max: 100, tgt: 100 },
    ];
    it('counts the producing share of each hour at 100%, clipped to the run', () => {
        expect(poweredHoursFromOutput(out, T0, T0 + 3 * H)).toBeCloseTo(2.5, 6);
        expect(poweredHoursFromOutput(out, T0 + 0.5 * H, T0 + 3 * H)).toBeCloseTo(2.0, 6);
    });
    it('is used when the off line has no hours, and a missing file means no runs', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
        const files = { runs: path.join(dir, 'runs.jsonl'), output: path.join(dir, 'out.jsonl') };
        clearSuperChlorCache();
        expect(readSuperChlorRuns(T0, files)).toEqual([]);
        fs.writeFileSync(files.runs, lines([{ t: iso(T0), id: 1, on: true }, { t: iso(T0 + 3 * H), id: 1, on: false }]));
        fs.writeFileSync(files.output, lines(out.map(o => Object.assign({ id: 1 }, o))));
        clearSuperChlorCache();
        const runs = readSuperChlorRuns(T0 + 4 * H, files);
        expect(runs.length).toBe(1);
        expect(runs[0].poweredHours).toBeCloseTo(2.5, 6);
    });
});
