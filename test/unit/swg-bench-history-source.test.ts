// SWG Assist Model Bench, the History panel's view of the water balance runs (controller/AutoSwgBenchHistorySource.ts): each run its own line,
// and the runs that advised acid as markers.
import { describe, expect, it } from 'vitest';
import { advicePointsOf, runPointsOf } from '../../controller/AutoSwgBenchHistorySource';

const runs = [
    { run: 1000, points: [[1000, 7.8, 0.1, 70, 90], [2000, 7.9, 0.15, 70, 89.9]] },
    { run: 3000, points: [[3000, 8.05, 0.25, 69, 89.8], [4000, 8.1, null, 69, 89.7]], advice: { level: 'recommended', doseFlOz: 30, doseTo: 7.6, reason: 'The pH is projected to reach 8.05 now.' } }
];

describe('the bench history source', () => {
    it('gives each run\'s points of a field as its own line, within the span', () => {
        expect(runPointsOf(runs, 1, 0, 5000)).toEqual([
            { t: 1000, v: 7.8, seg: 1000 }, { t: 2000, v: 7.9, seg: 1000 }, { t: 3000, v: 8.05, seg: 3000 }, { t: 4000, v: 8.1, seg: 3000 }
        ]);
        // a missing value is left out
        expect(runPointsOf(runs, 2, 0, 5000).map(p => p.t)).toEqual([1000, 2000, 3000]);
        expect(runPointsOf(runs, 3, 1500, 3500).map(p => p.v)).toEqual([70, 69]);
    });
    it('marks the runs that advised acid, with the dose', () => {
        expect(advicePointsOf(runs, 0, 5000)).toEqual([{ t: 3000, v: 8.05, text: 'Acid recommended: 30 fl oz to 7.6. The pH is projected to reach 8.05 now.' }]);
        expect(advicePointsOf(runs, 0, 2000)).toEqual([]);
    });
});
