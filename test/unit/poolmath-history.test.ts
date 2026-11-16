// The PoolMath archive keeps everything PoolMath sends (controller/PoolMathArchive.ts toEntry, poolDetailsOf), the top-up follows PoolMath by
// log id (mergeTopUp), and the archive reads back as history series (historyKindsOf, historySeriesOf). The log shapes below are the ones
// PoolMath's share JSON sends (field names and units checked against a real share).
import { describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ poolMath: { shareCode: '', poolName: '', gallons: 0, swgLbsPerDay: 0, historyKinds: undefined as string[] | undefined } }));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/ChlorinatorLogService', () => ({ setPoolLogSwgEntriesSource: () => {}, recountCellUsage: () => {} }));
vi.mock('../../controller/Equipment', () => ({ sys: { poolMath: fx.poolMath, chlorinators: { length: 0, toArray: () => [] } } }));

import { PoolMathArchiveEntry, historyKindsOf, historySeriesOf, mergeTopUp, poolDetailsOf, toEntry } from '../../controller/PoolMathArchive';
import { DEFAULT_HISTORY_KINDS, selectedHistoryKinds, setPoolMathSettings } from '../../controller/PoolMathSync';

const weather = { cloudCover: 9, desc: 'Sunny', icon: 1, precipPast24Hours: 4.6, pressure: 1019.3, relHumidity: 68, temp: 30, uvIndex: 8, windDir: 45, windDirDesc: 'NE' };
const testLog = (id: string, ts: string, extra: any = {}) => ({ id, type: 'testlog', logTimestamp: ts, poolId: 'p', _ts: 1, deleted: false, fc: 6.5, cc: 0, ph: 7.6, csi: -0.12, waterTemp: 80, waterTempUnits: 0, weather, ...extra });
const chemLog = (id: string, ts: string, chemical: number, unit: number, amount: number, normalizedAmount: number, extra: any = {}) =>
    ({ id, type: 'chemlog', logTimestamp: ts, poolId: 'p', _ts: 1, deleted: false, chemical, unit, amount, normalizedAmount, percent: null, runTime: null, weather, ...extra });
const T = '2026-11-01T14:00:00Z';
const at = (min: number) => new Date(new Date(T).getTime() + min * 60000).toISOString();

describe('toEntry', () => {
    it('keeps every test value, the full weather, and leaves out PoolMath bookkeeping', () => {
        const e = toEntry(testLog('t1', T, { bor: 30 }));
        expect(e).toMatchObject({ id: 't1', type: 'testlog', fc: 6.5, ph: 7.6, csi: -0.12, bor: 30, waterTemp: 80, waterTempUnits: 0, uvIndex: 8, weatherTemp: 30, cloudCover: 9 });
        expect(e.weather).toEqual(weather);
        expect(e.extra).toBeUndefined();
        expect(e).not.toHaveProperty('poolId');
        expect(e).not.toHaveProperty('_ts');
    });
    it('keeps a field it does not know (a note, a new test) in extra, and skips empty ones', () => {
        const e = toEntry(testLog('t1', T, { notes: 'drained 6 inches', tds: 1200, blank: '', none: null }));
        expect(e.extra).toEqual({ notes: 'drained 6 inches', tds: 1200 });
    });
    it('keeps a chemical entry with its unit and normalized amount, without the nulls', () => {
        const e = toEntry(chemLog('c1', T, 14, 4, 32, 946.35));
        expect(e).toMatchObject({ type: 'chemlog', chemical: 14, unit: 4, amount: 32, normalizedAmount: 946.35 });
        expect(e).not.toHaveProperty('percent');
    });
});

describe('poolDetailsOf', () => {
    it('keeps the pool details but never the share code or account ids', () => {
        const d = poolDetailsOf({ pool: { name: 'Main Pool', volume: 12000, buildType: 1, borTarget: 50, shareCode: 'secret', shareWithCode: true, userId: 'u', id: 'p', saltMax: null } });
        expect(d).toEqual({ name: 'Main Pool', volume: 12000, buildType: 1, borTarget: 50 });
    });
});

describe('mergeTopUp', () => {
    const archived = (): PoolMathArchiveEntry[] => [
        toEntry(testLog('t0', '2025-06-26T12:00:00Z')),
        toEntry(testLog('t1', T)),
        toEntry(chemLog('salt1', at(10), 26, 6, 40, 18143.69)),
    ];
    it('replaces an entry PoolMath edited (same id)', () => {
        const r = mergeTopUp(archived(), [toEntry(testLog('t1', T, { fc: 7 }))], new Set(), 0);
        expect(r.entries.find(e => e.id === 't1').fc).toBe(7);
        expect(r).toMatchObject({ updated: 1, testsEnriched: 1, added: 0, removed: 0 });
    });
    it('counts nothing when PoolMath returned the entry unchanged', () => {
        const r = mergeTopUp(archived(), [toEntry(testLog('t1', T))], new Set(), 0);
        expect(r).toMatchObject({ added: 0, updated: 0, removed: 0 });
    });
    it('removes a deleted entry of any kind', () => {
        const r = mergeTopUp(archived(), [], new Set(['salt1', 't1']), 0);
        expect(r.entries.map(e => e.id)).toEqual(['t0']);
        expect(r.removed).toBe(2);
    });
    it('adds every kind it has not got: acid, stabilizer, salt, tests', () => {
        const fetched = [
            toEntry(chemLog('acid1', at(20), 14, 4, 32, 946.35)),
            toEntry(chemLog('cya1', at(30), 24, 7, 24, 680.39)),
            toEntry(chemLog('salt2', at(40), 26, 6, 40, 18143.69)),
            toEntry(testLog('t2', at(50))),
        ];
        const r = mergeTopUp(archived(), fetched, new Set(), 0);
        expect(r).toMatchObject({ added: 4, saltAdded: 1, stabilizerAdded: 1, testsAdded: 1 });
        expect(r.entries.map(e => e.id)).toEqual(['t0', 't1', 'salt1', 'acid1', 'cya1', 'salt2', 't2']);
    });
    it('replaces an entry added from elsewhere with PoolMath\'s own entry for the same reading', () => {
        const fromPage: PoolMathArchiveEntry = { id: 'page:x', type: 'testlog', ts: at(61), fc: 5 };
        const r = mergeTopUp([...archived(), fromPage], [toEntry(testLog('t3', at(60)))], new Set(), 0);
        expect(r.entries.map(e => e.id)).not.toContain('page:x');
        expect(r.entries.map(e => e.id)).toContain('t3');
        expect(r).toMatchObject({ added: 0, updated: 1 });
    });
    it('leaves entries older than the retention cutoff out', () => {
        const r = mergeTopUp([], [toEntry(testLog('old', '2020-01-01T00:00:00Z'))], new Set(), new Date('2022-01-01').getTime());
        expect(r.entries).toEqual([]);
    });
});

describe('history series', () => {
    const entries = [
        toEntry(testLog('t1', T, { notes: 'backwashed' })),
        toEntry(chemLog('cl1', at(5), 0, 4, 8, 236.59, { percent: 10 })),
        toEntry(chemLog('acid1', at(6), 14, 4, 32, 946.35)),
        toEntry(chemLog('x1', at(7), 99, 3, 2, 2)),
        toEntry({ ...chemLog('swg1', at(8), 27, 8, 2.1, 2.1), percent: 28, runTime: 12 }),
        toEntry(testLog('t2', at(60 * 24), { fc: 5 })),
        // archived before the full weather was kept
        { id: 'legacy', type: 'testlog', ts: at(-60), fc: 4, uvIndex: 3 } as PoolMathArchiveEntry,
    ];
    it('lists every kind with name, unit, group and count, tests first', () => {
        const kinds = historyKindsOf(entries);
        const by = (k: string) => kinds.find(x => x.kind === k);
        expect(kinds[0].kind).toBe('fc');
        expect(by('fc')).toMatchObject({ name: 'FC', unit: 'ppm', group: 'test', count: 3 });
        expect(by('waterTemp')).toMatchObject({ unit: '°F' });
        expect(by('chem:14')).toMatchObject({ name: 'Muriatic Acid', unit: 'fl oz', group: 'addition', count: 1 });
        expect(by('chem:99')).toMatchObject({ name: 'Chemical 99', unit: 'unit 3' });
        expect(by('swg')).toMatchObject({ unit: '%', group: 'addition' });
        expect(by('weather:precipPast24Hours')).toMatchObject({ unit: 'mm', group: 'weather' });
        expect(by('weather:uvIndex').count).toBe(entries.length);
        expect(by('notes')).toMatchObject({ group: 'log', count: 1 });
        expect(by('weather:icon')).toBeUndefined();
        expect(by('weather:desc')).toBeUndefined();
    });
    it('gives the points of the asked kinds in the span, oldest first, with text for additions and notes', () => {
        const from = new Date(at(-120)).getTime(), to = new Date(at(60)).getTime();
        const s = historySeriesOf(entries, ['fc', 'chem:0', 'swg', 'notes', 'ta'], from, to);
        expect(s.fc.map(p => p.v)).toEqual([4, 6.5]);
        expect(s['chem:0']).toEqual([{ t: new Date(at(5)).getTime(), v: 8, text: '8 fl oz of Liquid Chlorine 10%' }]);
        expect(s.swg[0]).toMatchObject({ v: 28, text: '2.1 ppm FC, SWG 12 h @ 28%' });
        expect(s.notes[0].text).toBe('backwashed');
        expect(s.ta).toEqual([]);
    });
});

describe('history kinds setting', () => {
    it('defaults to what was kept from PoolMath before, and takes a chosen list', () => {
        fx.poolMath.historyKinds = undefined;
        expect(selectedHistoryKinds()).toEqual(DEFAULT_HISTORY_KINDS);
        setPoolMathSettings({ historyKinds: ['fc', 'csi', 'fc'] });
        expect(fx.poolMath.historyKinds).toEqual(['fc', 'csi']);
        setPoolMathSettings({ historyKinds: null });
        expect(fx.poolMath.historyKinds).toBeUndefined();
    });
    it('refuses a list that is not kind ids', () => {
        expect(() => setPoolMathSettings({ historyKinds: 'fc' })).toThrow(RangeError);
        expect(() => setPoolMathSettings({ historyKinds: [1] })).toThrow(RangeError);
    });
});
