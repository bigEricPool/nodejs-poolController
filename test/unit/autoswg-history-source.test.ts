// SWG Assist's source for the History panel (controller/AutoSwgHistorySource.ts): the projection by calculation run and the FC range steps.
import { describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ autoSwg: { shareCode: 'x', enabled: true, controlMode: 'range', fcLow: 6, fcHigh: 9, targetFc: 7, awayEnabled: false, awayTargetFc: 5 } as any }));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/Equipment', () => ({ sys: { autoSwg: fx.autoSwg } }));
vi.mock('../../controller/AutoSwgProjection', () => ({ projectionLog: { read: () => [
    { t: 5, fc: 8, kind: 'applied', run: 1 }, { t: 20, fc: 7.5, kind: 'test', run: 1 }, { t: 30, fc: NaN, kind: 'test', run: 2 }, { t: 40, fc: 6, kind: 'hourly', run: 2 }] } }));
vi.mock('../../controller/AutoSwgHistory', () => ({ readAutoSwgHistory: () => [] }));
vi.mock('../../controller/AutoSwgSteps', () => ({ rangeSince: () => undefined, buildSteps: () => [{ t: 1, low: 6, high: 9 }, { t: 10, target: 5 }, { t: 20 }] }));

import { autoSwgHistorySource, projectionPointsOf, rangePointsOf } from '../../controller/AutoSwgHistorySource';

describe('SWG Assist history source', () => {
    it('gives the projection in the span, each run its own segment, skipping values that are not numbers', () => {
        expect(projectionPointsOf([{ t: 5, fc: 8, kind: 'applied', run: 1 } as any, { t: 20, fc: 7.5, kind: 'test', run: 1 } as any, { t: 40, fc: 6, kind: 'hourly', run: 2 } as any], 10, 50))
            .toEqual([{ t: 20, v: 7.5, seg: 1 }, { t: 40, v: 6, seg: 2 }]);
    });
    it('turns a range into lo-hi, a target into a band of no width, and no target into a bare point', () => {
        expect(rangePointsOf([{ t: 1, low: 9, high: 6 }, { t: 10, target: 5 }, { t: 20 }])).toEqual([{ t: 1, lo: 6, hi: 9 }, { t: 10, lo: 5, hi: 5 }, { t: 20 }]);
    });
    it('offers its kinds in the FC view only with a share code', () => {
        expect(autoSwgHistorySource.kinds().map(k => [k.kind, k.style, k.view, !!k.future])).toEqual([['projection', 'line', 'FC', true], ['range', 'band', 'FC', false]]);
        expect(autoSwgHistorySource.series(['projection', 'range'], 0, 100)).toEqual({
            projection: [{ t: 5, v: 8, seg: 1 }, { t: 20, v: 7.5, seg: 1 }, { t: 40, v: 6, seg: 2 }],
            range: [{ t: 1, lo: 6, hi: 9 }, { t: 10, lo: 5, hi: 5 }, { t: 20 }]
        });
        fx.autoSwg.shareCode = '';
        expect(autoSwgHistorySource.kinds()).toEqual([]);
        expect(autoSwgHistorySource.series(['projection'], 0, 100)).toEqual({});
    });
});
