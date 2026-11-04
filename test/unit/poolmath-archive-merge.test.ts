// The full PoolMath sync's merge (controller/PoolMathArchive.ts dropSupersededEntries): an archived entry added from elsewhere under
// an id of its own is replaced by PoolMath's own entry for the same reading, not kept beside it.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PoolMathArchiveEntry, archiveIsForPool, backUpPoolMathArchive, dropSupersededEntries } from '../../controller/PoolMathArchive';

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

describe('archiveIsForPool', () => {
    const archive = { shareCode: 'abc', poolName: 'Kentshire', entries: [test('pm1', T), test('pm0', '2025-06-26T12:00:00.000Z')] };
    it('keeps the archive for the same share code and pool name', () => {
        expect(archiveIsForPool(archive, 'abc', 'Kentshire', [])).toBe(true);
    });
    it('keeps it for a renamed pool or a new share link when PoolMath returns a log id it already has', () => {
        expect(archiveIsForPool(archive, 'abc', 'Kentshire Pool', ['pm9', 'pm1'])).toBe(true);
        expect(archiveIsForPool(archive, 'xyz', 'Kentshire', ['pm0'])).toBe(true);
    });
    it('starts fresh for a different pool', () => {
        expect(archiveIsForPool(archive, 'abc', 'Other Pool', ['q1', 'q2'])).toBe(false);
        expect(archiveIsForPool(archive, 'abc', 'Other Pool', [])).toBe(false);
    });
    it('has nothing to lose with an empty archive', () => {
        expect(archiveIsForPool({ entries: [] }, 'abc', 'Other Pool', ['q1'])).toBe(true);
    });
});

describe('backUpPoolMathArchive', () => {
    it('copies the archive aside and leaves the archive in place', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmarchive-'));
        const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
        try {
            expect(backUpPoolMathArchive()).toBeUndefined();   // no archive yet
            fs.mkdirSync(path.join(dir, 'data'));
            const file = path.join(dir, 'data', 'poolMathArchive.json');
            fs.writeFileSync(file, '{"entries":[{"id":"pm1"}]}');
            const bak = backUpPoolMathArchive();
            expect(bak).toBeDefined();
            expect(fs.readFileSync(bak as string, 'utf8')).toBe('{"entries":[{"id":"pm1"}]}');
            expect(fs.existsSync(file)).toBe(true);
        } finally { cwd.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
