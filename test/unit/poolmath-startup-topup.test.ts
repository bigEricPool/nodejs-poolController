// PoolMath reads after a restart (controller/PoolMathSync.ts): the first top-up waits until the next scheduled one is due, so a restart
// reads PoolMath only when a scheduled read was missed; the times survive a restart in data/poolMathReadTimes.json.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ archive: { entries: [] } as any, topUps: [] as number[] }));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/ChlorinatorLogService', () => ({ setPoolLogSwgEntriesSource: () => {}, recountCellUsage: () => {} }));
vi.mock('../../controller/Equipment', () => ({ sys: { poolMath: { shareCode: 'abc', poolName: '' }, chlorinators: { length: 1, toArray: () => [] } } }));
vi.mock('../../controller/PoolMathArchive', () => ({
    archivedSwgEvents: () => [], historyKindsOf: () => [], historySeriesOf: () => ({}),
    isPoolMathArchiveCurrent: () => true, poolMathArchiveSummary: () => ({ count: 0 }),
    readPoolMathArchive: () => fx.archive, syncPoolMathArchive: async () => { throw new Error('no sync in this test'); },
    topUpPoolMathArchive: async (_c: string, _n: string, size: number) => { fx.topUps.push(size); return { added: 0, updated: 0, removed: 0, pool: {} }; },
    TOP_UP_SMALL: 25, TOP_UP_WIDE: 500,
}));

import { firstTopUpDelayMs, loadReadTimes, startPoolMathSync, stopPoolMathSync } from '../../controller/PoolMathSync';

const MIN = 60 * 1000;
let cwd: string;
let tmp: string;
beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-times-'));
    process.chdir(tmp);
    fx.archive = { entries: [] };
    fx.topUps = [];
});
afterEach(() => {
    stopPoolMathSync();
    vi.useRealTimers();
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('firstTopUpDelayMs', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    it('waits until the next scheduled top-up is due', () => {
        expect(firstTopUpDelayMs(now - 10 * MIN, now)).toBe(35 * MIN);
    });
    it('reads soon after the start when a top-up was missed', () => {
        expect(firstTopUpDelayMs(now - 3 * 3600 * 1000, now)).toBe(2 * MIN);
        expect(firstTopUpDelayMs(now - 44 * MIN, now)).toBe(2 * MIN);
    });
    it('reads soon after the start when no top-up was ever recorded', () => {
        expect(firstTopUpDelayMs(0, now)).toBe(2 * MIN);
    });
    it('waits a full interval when the last top-up is in the future (clock went back)', () => {
        expect(firstTopUpDelayMs(now + 5 * MIN, now)).toBe(45 * MIN);
    });
});

describe('startup', () => {
    it('does not read PoolMath before the next scheduled top-up, and keeps it small when the wide read is recent', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const now = Date.parse('2026-11-15T12:00:00Z');
        vi.setSystemTime(now);
        fs.mkdirSync('data');
        fs.writeFileSync(path.join('data', 'poolMathReadTimes.json'), JSON.stringify({ topUpAt: new Date(now - 5 * MIN).toISOString(), wideAt: new Date(now - 3600 * 1000).toISOString() }));
        startPoolMathSync();
        await vi.advanceTimersByTimeAsync(39 * MIN);
        expect(fx.topUps).toEqual([]);
        await vi.advanceTimersByTimeAsync(1 * MIN + 1000);
        expect(fx.topUps).toEqual([25]);
        expect(loadReadTimes().topUpAt).toBeGreaterThanOrEqual(now + 40 * MIN);
    });
    it('reads two minutes after the start when the scheduled top-up was missed, wide when the last wide read is a day old', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const now = Date.parse('2026-11-15T12:00:00Z');
        vi.setSystemTime(now);
        fs.mkdirSync('data');
        fs.writeFileSync(path.join('data', 'poolMathReadTimes.json'), JSON.stringify({ topUpAt: new Date(now - 6 * 3600 * 1000).toISOString(), wideAt: new Date(now - 25 * 3600 * 1000).toISOString() }));
        startPoolMathSync();
        await vi.advanceTimersByTimeAsync(2 * MIN - 1000);
        expect(fx.topUps).toEqual([]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fx.topUps).toEqual([500]);
        expect(loadReadTimes().wideAt).toBeGreaterThanOrEqual(now + 2 * MIN);
    });
    it('without a saved time, uses the archive\'s last changed top-up and its full sync time', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const now = Date.parse('2026-11-15T12:00:00Z');
        vi.setSystemTime(now);
        fx.archive = { entries: [], toppedUpAt: new Date(now - 15 * MIN).toISOString(), syncedAt: new Date(now - 3600 * 1000).toISOString() };
        startPoolMathSync();
        await vi.advanceTimersByTimeAsync(29 * MIN);
        expect(fx.topUps).toEqual([]);
        await vi.advanceTimersByTimeAsync(2 * MIN);
        expect(fx.topUps).toEqual([25]);
    });
});
