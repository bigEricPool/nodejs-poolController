// SWG Assist holds its automatic changes while super chlorinate is on and makes up one check after (controller/AutoSwgSuperChlorHold.ts; wired in
// web/services/state/State.ts). A held change is in the history but is never read as an SWG % change.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { normalSwgPct, superChlorHoldUpdate, superChlorOn } from '../../controller/AutoSwgSuperChlorHold';
import { toLocalSwgEntries } from '../../controller/AutoSwgHistory';

describe('super chlorinate hold', () => {
    it('is on for a pool or shared chlorinator running super chlorinate, not for the spa only', () => {
        expect(superChlorOn({ superChlor: true }, 0)).toBe(true);
        expect(superChlorOn({ superChlor: true }, 32)).toBe(true);
        expect(superChlorOn({ superChlor: true }, 1)).toBe(false);
        expect(superChlorOn({ superChlor: false }, 0)).toBe(false);
        expect(superChlorOn(undefined, 0)).toBe(false);
    });

    it('holds during the run and makes up one check once it ends, only when a change was held', () => {
        // the run starts: the flag goes on, nothing to make up
        expect(superChlorHoldUpdate(true, undefined)).toEqual({ hold: true, makeUp: false, clearHeldAt: false });
        // an automatic check was held during it: still holding
        const heldAt = '2026-11-16T15:00:00.000Z';
        expect(superChlorHoldUpdate(true, heldAt)).toEqual({ hold: true, makeUp: false, clearHeldAt: false });
        // the run ended: the make-up check, once (heldAt is cleared, so the next look does nothing)
        expect(superChlorHoldUpdate(false, heldAt)).toEqual({ hold: false, makeUp: true, clearHeldAt: true });
        expect(superChlorHoldUpdate(false, undefined)).toEqual({ hold: false, makeUp: false, clearHeldAt: false });
    });

    it('the normal % during a run is the setpoint, not the 100% output (the held record of 2026-11-16 stored 100)', () => {
        expect(normalSwgPct({ superChlor: true, targetOutput: 100, poolSetpoint: 4 })).toBe(4);
        expect(normalSwgPct({ superChlor: false, targetOutput: 4, poolSetpoint: 4 })).toBe(4);
        expect(normalSwgPct({ superChlor: true, targetOutput: 100 })).toBe(100);
        expect(normalSwgPct(undefined)).toBeUndefined();
    });

    it('a held change in the history is not an SWG % entry', () => {
        const entries = toLocalSwgEntries([
            { source: 'auto', appliedAt: '2026-11-16T10:00:00.000Z', appliedPct: 20, ppmPerDay: 0.98, hrs: 10 },
            { source: 'held', held: 'super chlorinate', trigger: 'automatic-check', appliedAt: '2026-11-16T15:00:00.000Z', recommendedPct: 30, previousPct: 20 },
        ]);
        expect(entries.length).toBe(1);
        expect(entries[0].pct).toBe(20);
    });
});
