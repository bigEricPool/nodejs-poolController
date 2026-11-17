// The chlorinator's Power and Current (modelled) history kinds (controller/HistorySources.ts): the power log's on times as spans, the
// cycle count's bursts as spans, fault hours left out, and daily hours in long views.
import { describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
    chlor: { id: 50, name: 'Cell', cycleHours: 3, cycleRestartsOnPower: true, burstFirst: true } as any,
    power: [] as any[],
    hours: [] as any[],
}));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/Equipment', () => ({
    sys: {
        board: { valueMaps: { tempUnits: { getName: () => 'F' } } },
        chlorinators: { toArray: () => [fx.chlor], find: (fn: any) => [fx.chlor].find(fn) },
    }
}));
vi.mock('../../controller/State', () => ({ state: { temps: { units: 0 }, getTempHistory: () => undefined } }));
vi.mock('../../controller/ChlorinatorLog', () => ({ chlorinatorLog: { read: () => fx.hours } }));
vi.mock('../../controller/ChlorinatorLogService', () => ({ firstChlorinatorId: () => 50 }));
vi.mock('../../controller/ChlorinatorPowerLog', () => ({ chlorinatorPowerLog: { lastEvent: () => fx.power[fx.power.length - 1], read: () => fx.power } }));
vi.mock('../../controller/PoolMathArchive', () => ({ readPoolMathArchive: () => ({ entries: [] }), historySeriesOf: () => ({}) }));
vi.mock('../../controller/PoolMathSync', () => ({ poolMathHistoryKinds: () => [] }));

import { chlorinatorHistorySource, currentSpansOf, dailyHoursOf, faultHoursOf, powerSpansOf } from '../../controller/HistorySources';

const H = 3600000, MIN = 60000;
const T0 = Date.parse('2026-07-01T12:00:00.000Z');
const at = (h: number) => T0 + h * H;

describe('powerSpansOf', () => {
    it('gives each on time cut to the span, says what ended it, and runs to the end while on', () => {
        const ev = [{ t: at(-1), on: true }, { t: at(1), on: false, cause: 'stall' }, { t: at(1) + 100, on: true }, { t: at(2), on: false, cause: 'outage' },
            { t: at(3), on: true }, { t: at(4), on: false }, { t: at(5), on: true }];
        expect(powerSpansOf(ev, at(0), at(6))).toEqual([
            { t: at(0), e: at(1), text: 'off: njsPC stalled' }, { t: at(1) + 100, e: at(2), text: 'off: njsPC stopped' },
            { t: at(3), e: at(4) }, { t: at(5), e: at(6), text: 'on now' }]);
    });
    it('gives nothing while off, and joins two on lines in a row', () => {
        expect(powerSpansOf([{ t: at(0), on: false }], at(0), at(6))).toEqual([]);
        expect(powerSpansOf([{ t: at(0), on: true }, { t: at(1), on: true }, { t: at(2), on: false }], at(0), at(6))).toEqual([{ t: at(0), e: at(2) }]);
    });
});

describe('currentSpansOf', () => {
    it('leaves out the hours with a fault the cell reported, and carries the % of the cycle', () => {
        const iv = [{ start: at(0.5), end: at(2.5), cycle: at(0.5), pct: 67 }, { start: at(3), end: at(3.5), cycle: at(3), pct: 10 }];
        expect(currentSpansOf(iv, faultHoursOf([{ t: new Date(at(1)).toISOString(), st: [8] }, { t: new Date(at(3)).toISOString(), st: [128, 16] }])))
            .toEqual([{ t: at(0.5), e: at(1), v: 67 }, { t: at(2), e: at(2.5), v: 67 }, { t: at(3), e: at(3.5), v: 10 }]);
    });
});

describe('dailyHoursOf', () => {
    it('sums the hours of each local day, 0 for a day with none', () => {
        const d0 = new Date(2026, 6, 1).getTime(), d1 = new Date(2026, 6, 2).getTime(), d2 = new Date(2026, 6, 3).getTime();
        const spans = [{ t: d0 + 2 * H, e: d0 + 3.5 * H }, { t: d1 - H, e: d1 + 0.25 * H }];
        expect(dailyHoursOf(spans, d0, d2 + 12 * H)).toEqual([{ t: d0, v: 2.5 }, { t: d1, v: 0.25 }, { t: d2, v: 0 }]);
    });
});

describe('the Power and Current (modelled) kinds', () => {
    // 2026-11-17 (EST, UTC-5): on at 06:50 at 9%, the 09:50 cycle bursts to 10:06, the % is 0 from 10:00, a restart at 10:15 starts a 0% cycle
    const T = (hh: number, mm: number) => Date.UTC(2026, 10, 17, hh + 5, mm);
    const line = (hh: number, pct: number, st?: number[]) => ({ t: new Date(T(hh, 0)).toISOString(), id: 50, n: 6, on: pct > 0 ? 6 : 0, out: pct, max: pct, set: pct, tgt: pct, salt: 3200, st });
    const burst = 0.09 * 3 * H;
    it('are listed for a chlorinator with a power log, current only when it is counted by cycles', () => {
        fx.power = [{ t: new Date(T(6, 50)).toISOString(), id: 50, on: true }];
        expect(chlorinatorHistorySource.kinds().filter(k => k.style === 'spans').map(k => [k.kind, k.name, k.view]))
            .toEqual([['50:power', 'Cell Power', 'FC'], ['50:current', 'Cell Current (modelled)', 'FC']]);
        fx.chlor.cycleHours = 0;
        expect(chlorinatorHistorySource.kinds().filter(k => k.style === 'spans').map(k => k.kind)).toEqual(['50:power']);
        fx.chlor.cycleHours = 3;
        fx.power = [];
        expect(chlorinatorHistorySource.kinds().filter(k => k.style === 'spans')).toEqual([]);
    });
    it('show the 2026-11-17 morning', () => {
        fx.power = [{ t: new Date(T(6, 50)).toISOString(), id: 50, on: true }, { t: new Date(T(10, 15)).toISOString(), id: 50, on: false, cause: 'stall' },
            { t: new Date(T(10, 15) + 1000).toISOString(), id: 50, on: true }];
        fx.hours = [line(6, 9), line(7, 9), line(8, 9), line(9, 9), line(10, 0), line(11, 0)];
        vi.useFakeTimers({ now: T(11, 0), toFake: ['Date'] });
        try {
            const s = chlorinatorHistorySource.series(['50:power', '50:current'], T(6, 0), T(11, 0));
            expect(s['50:power']).toEqual([{ t: T(6, 50), e: T(10, 15), text: 'off: njsPC stalled' }, { t: T(10, 15) + 1000, e: T(11, 0), text: 'on now' }]);
            expect(s['50:current']).toEqual([{ t: T(6, 50), e: T(6, 50) + burst, v: 9 }, { t: T(9, 50), e: T(9, 50) + burst, v: 9 }]);
            // a month: the hours of each day
            const m = chlorinatorHistorySource.series(['50:current'], T(11, 0) - 30 * 24 * H, T(11, 0));
            expect(m['50:current'][m['50:current'].length - 1]).toEqual({ t: new Date(2026, 10, 17).getTime(), v: Math.round(2 * burst / H * 100) / 100 });
            // and only from the day the power log began
            expect(m['50:current'].map(p => p.t)).toEqual([new Date(2026, 10, 17).getTime()]);
        } finally { vi.useRealTimers(); }
    });
});
