// SWG Assist Model Bench: the live rows follow SWG Assist's projection at each test when it is worked out again (controller/AutoSwgBench.ts
// syncLiveRows). The case that raised it: on 2026-11-16 SWG Assist's projections since 11-08 were worked out again with the cycle count; the bench
// had scored the 11-14 test (10 ppm) with the old projection 11.07, and it is 11.33 now.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import type { BenchScoreRow } from '../../controller/AutoSwgBench';
import { DEFAULT_SCORING, syncLiveRows } from '../../controller/AutoSwgBenchModel';

const T = Date.parse('2026-11-14T15:17:29.000Z'), T1 = Date.parse('2026-11-12T23:46:22.000Z');
const live = (over: Partial<BenchScoreRow> = {}): BenchScoreRow => Object.assign({
    t: T, id: 'live', v: 1, horizon: 'next', mode: 'live', t1: T1, f1: 11.5, test: 10, proj: 11.07, miss: -1.07, days: 1.65, gen: 0.9, cov: 1
} as BenchScoreRow, over);

describe('syncLiveRows', () => {
    it('updates a live row to the projection worked out now, keeping the first one', () => {
        const r = live();
        expect(syncLiveRows([r], [{ t: T, fc: 11.33 }], DEFAULT_SCORING)).toBe(1);
        expect(r.proj).toBe(11.33);
        expect(r.miss).toBe(-1.33);
        expect(r.liveWas).toBe(11.07);
        // a second change keeps the first projection
        expect(syncLiveRows([r], [{ t: T, fc: 11.4 }], DEFAULT_SCORING)).toBe(1);
        expect(r.liveWas).toBe(11.07);
    });
    it('leaves alone a row that already matches, model rows, replay rows, and tests with no point', () => {
        const same = live({ proj: 11.33, miss: -1.33 });
        const model = live({ mode: 'nowcast', id: 'sun-cya-30' });
        const replay = live({ replay: true });
        const other = live({ t: T + 86400000 });
        expect(syncLiveRows([same, model, replay, other], [{ t: T, fc: 11.33 }], DEFAULT_SCORING)).toBe(0);
        expect(model.proj).toBe(11.07);
        expect(replay.proj).toBe(11.07);
        expect(other.proj).toBe(11.07);
    });
    it('judges the flags again: a projection above the start plus what was made is implausible', () => {
        const r = live({ gen: 0.1 });   // 11.5 + 0.1 = 11.6
        syncLiveRows([r], [{ t: T, fc: 11.7 }], DEFAULT_SCORING);
        expect(r.flags).toContain('implausible');
        syncLiveRows([r], [{ t: T, fc: 11.33 }], DEFAULT_SCORING);
        expect(r.flags).toBeUndefined();
    });
});
