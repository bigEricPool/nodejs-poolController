// The history registry (controller/History.ts) and njsPC's own sources (controller/HistorySources.ts): kind ids, the query of
// GET /state/history, the daily buckets, and how the temperature and chlorinator logs and PoolMath become points.
import { describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
    tempHistory: undefined as any,
    chlorHours: [] as any[],
    pmKinds: [] as any[],
}));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/Equipment', () => ({
    sys: {
        board: { valueMaps: { tempUnits: { getName: () => 'F' } } },
        chlorinators: { toArray: () => [{ id: 50, name: 'Cell' }] },
    }
}));
vi.mock('../../controller/State', () => ({ state: { temps: { units: 0 }, getTempHistory: () => fx.tempHistory } }));
vi.mock('../../controller/ChlorinatorLog', () => ({ chlorinatorLog: { read: () => fx.chlorHours } }));
vi.mock('../../controller/ChlorinatorLogService', () => ({ firstChlorinatorId: () => 50 }));
vi.mock('../../controller/PoolMathArchive', () => ({
    readPoolMathArchive: () => ({ entries: [] }),
    historySeriesOf: (entries: any[], kinds: string[]) => { const s: any = {}; for (const k of kinds) s[k] = [{ t: 5, v: 7 }]; return s; },
}));
vi.mock('../../controller/PoolMathSync', () => ({ poolMathHistoryKinds: () => fx.pmKinds }));

import { bucketPoints, HistoryRegistry, parseHistoryQuery } from '../../controller/History';
import { chlorinatorHistorySource, chlorPointsOf, poolMathHistorySource, poolMathStyleOf, tempHistorySource, tempPointsOf, tempRangeFor } from '../../controller/HistorySources';

const DAY = 86400000;
const src = (id: string, kinds: any[], series: (k: string[], f: number, t: number) => any) => ({ id, name: id.toUpperCase(), kinds: () => kinds, series });

describe('HistoryRegistry', () => {
    it('names each kind <source>:<kind> with its source', () => {
        const r = new HistoryRegistry();
        r.register(src('a', [{ kind: 'x', name: 'X', unit: '', group: 'g', style: 'line' }], () => ({})));
        r.register(src('b', [{ kind: '1:out', name: 'Out', unit: '%', group: 'g', style: 'line' }], () => ({})));
        expect(r.kinds().map(k => [k.id, k.source, k.sourceName])).toEqual([['a:x', 'a', 'A'], ['b:1:out', 'b', 'B']]);
    });
    it('refuses a source id with a colon, and replaces a source registered again', () => {
        const r = new HistoryRegistry();
        expect(() => r.register(src('a:b', [], () => ({})))).toThrow();
        r.register(src('a', [{ kind: 'x' }], () => ({})));
        r.register(src('a', [{ kind: 'y' }], () => ({})));
        expect(r.kinds().map(k => k.id)).toEqual(['a:y']);
    });
    it('asks each source once for its own kinds, splitting at the first colon', () => {
        const r = new HistoryRegistry();
        const calls: string[][] = [];
        r.register(src('b', [], (k) => { calls.push(k); return { '1:out': [{ t: 20, v: 2 }, { t: 10, v: 1 }], '1:set': [] }; }));
        const s = r.series(['b:1:out', 'b:1:set', 'b:1:out', 'zz:q', 'bad', 'b:'], 0, 100);
        expect(calls).toEqual([['1:out', '1:set']]);
        expect(s).toEqual({ 'b:1:out': [{ t: 10, v: 1 }, { t: 20, v: 2 }] });
    });
    it('drops points outside the span and leaves out a source that fails', () => {
        const r = new HistoryRegistry();
        r.register(src('a', [], () => ({ x: [{ t: 5, v: 1 }, { t: 50, v: 2 }, { t: 500, v: 3 }] })));
        r.register(src('c', [], () => { throw new Error('boom'); }));
        r.register({ id: 'd', name: 'D', kinds: () => { throw new Error('boom'); }, series: () => ({}) });
        expect(r.series(['a:x', 'c:y'], 10, 100)).toEqual({ 'a:x': [{ t: 50, v: 2 }] });
        expect(r.kinds()).toEqual([]);
    });
});

describe('parseHistoryQuery', () => {
    const now = 10 * DAY;
    it('needs kinds, and defaults to the last day', () => {
        expect(parseHistoryQuery({}, now)).toHaveProperty('error');
        expect(parseHistoryQuery({ kinds: 'a:x, a:x ,b:y' }, now)).toEqual({ kinds: ['a:x', 'b:y'], from: 9 * DAY, to: now });
    });
    it('takes days, or from and to in ms or as dates, with to ahead of now', () => {
        expect(parseHistoryQuery({ kinds: 'a:x', days: '7' }, now)).toMatchObject({ from: 3 * DAY, to: now });
        expect(parseHistoryQuery({ kinds: 'a:x', from: String(DAY), to: String(12 * DAY) }, now)).toMatchObject({ from: DAY, to: 12 * DAY });
        expect(parseHistoryQuery({ kinds: 'a:x', from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' }, now))
            .toMatchObject({ from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 2) });
    });
    it('answers an error for bad values', () => {
        for (const q of [{ days: '0' }, { days: 'x' }, { from: 'nope' }, { to: '' }, { from: String(5 * DAY), to: String(DAY) }])
            expect(parseHistoryQuery({ kinds: 'a:x', ...q }, now)).toHaveProperty('error');
        expect(parseHistoryQuery({ kinds: Array.from({ length: 101 }, (_, i) => `a:${i}`).join(',') }, now)).toHaveProperty('error');
    });
});

describe('bucketPoints', () => {
    it('averages each bucket with its low and high, and keeps text and off points as they are', () => {
        const p = bucketPoints([{ t: 0, v: 1 }, { t: 10, v: 3, hi: 9 }, { t: 15, text: 'note' }, { t: 120, v: 5 }, { t: 130, v: 6, o: 1 }], 100, false);
        expect(p).toEqual([{ t: 0, v: 2, lo: 1, hi: 9 }, { t: 15, text: 'note' }, { t: 100, v: 5, lo: 5, hi: 5 }, { t: 130, v: 6, o: 1 }]);
    });
});

describe('temperature source', () => {
    it('picks the view by how far back the span reaches', () => {
        const now = 100 * DAY;
        expect(tempRangeFor(now - DAY, now)).toBe('day');
        expect(tempRangeFor(now - 7 * DAY, now)).toBe('week');
        expect(tempRangeFor(now - 30 * DAY, now)).toBe('month');
        expect(tempRangeFor(now - 365 * DAY, now)).toBe('year');
    });
    it('turns minute readings into points, marking off readings, and the setpoints into the solar band', () => {
        const p = tempPointsOf({ hysteresis: 1, t: [1, 2, 3], v: [80, 81, null], o: [null, 1, null], s: [85, null, 86] });
        expect(p.water).toEqual([{ t: 1, v: 80 }, { t: 2, v: 81, o: 1 }]);
        expect(p.solar).toEqual([{ t: 1, lo: 84, hi: 86 }, { t: 3, lo: 85, hi: 87 }]);
    });
    it('turns hourly rows into points with the low and high, and off rows into off points; no band without hysteresis', () => {
        const p = tempPointsOf({ t: [1, 2], v: [80, null], hi: [82, null], lo: [79, null], ov: [null, 75], s: [85, 85] });
        expect(p.water).toEqual([{ t: 1, v: 80, lo: 79, hi: 82 }, { t: 2, v: 75, o: 1 }]);
        expect(p.solar).toEqual([]);
    });
    it('offers each body, and its solar limits only when the body has them', () => {
        fx.tempHistory = { bodies: [{ id: 1, name: 'Pool', hysteresis: 1, t: [] }, { id: 2, name: 'Spa', t: [] }] };
        expect(tempHistorySource.kinds().map(k => [k.kind, k.name, k.unit, k.style]))
            .toEqual([['body1', 'Pool Water', '°F', 'line'], ['body1:solar', 'Pool Solar Limits', '°F', 'band'], ['body2', 'Spa Water', '°F', 'line']]);
        fx.tempHistory = { bodies: [{ id: 1, name: 'Pool', hysteresis: 1, t: [5], v: [80], s: [85] }] };
        expect(tempHistorySource.series(['body1:solar'], 0, 10)).toEqual({ 'body1:solar': [{ t: 5, lo: 84, hi: 86 }] });
    });
});

describe('chlorinator source', () => {
    const hours = [
        { t: new Date(2026, 10, 1, 10).toISOString(), out: 40, max: 100, set: 30, salt: 3200 },
        { t: new Date(2026, 10, 1, 11).toISOString(), out: 60, max: 100, set: 30, salt: 0 },
        { t: new Date(2026, 10, 2, 10).toISOString(), out: 20, max: 50, set: 25, salt: 3300 },
    ];
    it('gives the output with its highest, the setpoint, and leaves out a salt reading of 0', () => {
        expect(chlorPointsOf(hours, 'out', false).map(p => [p.v, p.hi])).toEqual([[40, 100], [60, 100], [20, 50]]);
        expect(chlorPointsOf(hours, 'salt', false).map(p => p.v)).toEqual([3200, 3300]);
    });
    it('shows a long span a day at a time, but not the setpoint', () => {
        expect(chlorPointsOf(hours, 'out', true).map(p => [p.v, p.lo, p.hi])).toEqual([[50, 40, 100], [20, 20, 50]]);
        expect(chlorPointsOf(hours, 'set', true).length).toBe(3);
    });
    it('names its kinds by chlorinator id', () => {
        expect(chlorinatorHistorySource.kinds().map(k => k.kind)).toEqual(['50:out', '50:set', '50:salt']);
        fx.chlorHours = hours;
        const from = new Date(2026, 10, 1).getTime();
        expect(Object.keys(chlorinatorHistorySource.series(['50:out', '50:bad', 'x:out'], from, from + 3 * DAY))).toEqual(['50:out']);
    });
});

describe('PoolMath source', () => {
    it('offers only the kinds chosen as Of Interest, tests as dots and additions as markers', () => {
        fx.pmKinds = [
            { kind: 'fc', name: 'FC', unit: 'ppm', group: 'test', count: 3, selected: true },
            { kind: 'ph', name: 'pH', unit: '', group: 'test', count: 3, selected: false },
            { kind: 'chem:0', name: 'Liquid Chlorine', unit: 'fl oz', group: 'addition', count: 1, selected: true },
        ];
        expect(poolMathHistorySource.kinds().map(k => [k.kind, k.style])).toEqual([['fc', 'dots'], ['chem:0', 'markers']]);
        expect(poolMathStyleOf('test', 'notes')).toBe('markers');
        expect(poolMathStyleOf('weather', 'weather:temp')).toBe('dots');
        expect(poolMathHistorySource.series(['fc'], 0, 10)).toEqual({ fc: [{ t: 5, v: 7 }] });
    });
});
