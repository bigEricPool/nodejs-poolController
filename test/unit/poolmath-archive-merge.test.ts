// The full PoolMath sync's merge (controller/PoolMathArchive.ts dropSupersededEntries): an archived entry added from elsewhere under
// an id of its own is replaced by PoolMath's own entry for the same reading, not kept beside it.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { PoolMathArchiveEntry, dropSupersededEntries } from '../../controller/PoolMathArchive';

const at = (iso: string, sec = 0) => new Date(new Date(iso).getTime() + sec * 1000).toISOString();
const T = '2026-10-20T14:00:00.000Z';
const test = (id: string, ts: string, fc = 5): PoolMathArchiveEntry => ({ id, type: 'testlog', ts, fc });
const chem = (id: string, ts: string, chemical: number): PoolMathArchiveEntry => ({ id, type: 'chemlog', ts, chemical, percent: 40 });

describe('dropSupersededEntries', () => {
    it('drops an entry with another id when PoolMath returned the same reading within two minutes', () => {
        const kept = dropSupersededEntries([test('other:1', at(T, 30))], [test('pm1', T)]);
        expect(kept).toEqual([]);
    });
    it('keeps it when PoolMath returned nothing of the same kind that close', () => {
        const archived = [test('other:1', at(T, 180)), chem('other:swg', T, 27)];
        const kept = dropSupersededEntries(archived, [test('pm1', T), chem('pm2', at(T, 30), 0)]);
        expect(kept.map(e => e.id)).toEqual(['other:1', 'other:swg']);
    });
    it('matches chemical entries only to the same chemical', () => {
        const kept = dropSupersededEntries([chem('other:swg', T, 27), chem('other:cl', T, 0)], [chem('pm2', at(T, 60), 27)]);
        expect(kept.map(e => e.id)).toEqual(['other:cl']);
    });
    it('keeps entries PoolMath returned under the same id, and older ones it no longer returns', () => {
        const archived = [test('pm1', T), test('pm0', '2025-06-26T12:00:00.000Z')];
        const kept = dropSupersededEntries(archived, [test('pm1', T, 6), test('pm3', at(T, 60))]);
        expect(kept.map(e => e.id)).toEqual(['pm1', 'pm0']);
    });
});
