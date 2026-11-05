// SWG Assist's "the chlorinator has not answered" alarm (controller/AutoSwgWatch.ts): the silence is measured from the later of the power coming on and the last answer.
import { describe, expect, it } from 'vitest';
import { AutoSwgWatch } from '../../controller/AutoSwgWatch';

const MIN = 60000;
const T0 = Date.UTC(2026, 10, 5, 11, 40);    // 06:40 local: the SWG relay's schedule turns the power on

function input(now: number, commAgeSec: number): any {
    return {
        now: now, inRunWindow: false, autoCheckEnabled: false, autoCheckHours: 12,
        chlorinator: { status: 8, statusDesc: 'Communication lost', currentOutput: 0, setpoint: 0, powered: true, commAgeSec: commAgeSec }
    };
}

describe('swg-silent alarm', () => {
    it('does not count the hours the SWG was off by design as silence', () => {
        const w = new AutoSwgWatch();
        w.evaluate(input(T0, 13 * 3600));                       // power just came on, the last answer was 13 hours ago
        expect(w.evaluate(input(T0 + 4 * MIN, 13 * 3600 + 240))).toEqual([]);   // still inside the start-up allowance
        const a = w.evaluate(input(T0 + 10 * MIN, 13 * 3600 + 600)).find(x => x.id === 'swg-silent');
        expect(a).toBeTruthy();
        expect(a.text).toContain('for 10 minutes since its power came on');
        expect(a.text).not.toContain('790');
        expect(a.since).toBe(new Date(T0).toISOString());
    });

    it('counts from the last answer when it answered after the power came on', () => {
        const w = new AutoSwgWatch();
        w.evaluate(input(T0, 13 * 3600));
        const now = T0 + 30 * MIN;
        const a = w.evaluate(input(now, 8 * 60)).find(x => x.id === 'swg-silent');    // answered 8 minutes ago, 22 minutes after power-on
        expect(a).toBeTruthy();
        expect(a.text).toContain('for 8 minutes while it should have power');
        expect(a.text).not.toContain('since its power came on');
        expect(a.since).toBe(new Date(now - 8 * MIN).toISOString());
    });

    it('stays quiet while it has answered within the last five minutes', () => {
        const w = new AutoSwgWatch();
        w.evaluate(input(T0, 13 * 3600));
        expect(w.evaluate(input(T0 + 30 * MIN, 120)).filter(x => x.id === 'swg-silent')).toEqual([]);
    });
});
