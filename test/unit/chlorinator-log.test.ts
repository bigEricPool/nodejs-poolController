// Hourly aggregation of the chlorinator output log (controller/ChlorinatorLog.ts), written to a temporary file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { ChlorinatorOutputLog, ChlorinatorOutputHour, idOf, summarizeOutput } from '../../controller/ChlorinatorLog';

const H = 3600000;
const T = new Date('2026-07-01T12:00:00.000Z').getTime();
const sample = (o: any) => ({ id: 1, output: 50, set: 50, target: 50, status: 0, salt: 3200, ...o });

let dir: string, file: string, log: ChlorinatorOutputLog;
const lines = (): ChlorinatorOutputHour[] => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chlorlog-'));
    file = path.join(dir, 'chlorinatorOutputLog.jsonl');
    log = new ChlorinatorOutputLog(file);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('ChlorinatorOutputLog.record', () => {
    it('builds one line an hour from the samples in it', () => {
        log.record(sample({ output: 0, salt: 3100 }), T);
        log.record(sample({ output: 50, status: 2, commAgeSec: 30 }), T + 10 * 60000);
        log.record(sample({ output: 100, set: 60, target: 60, status: 2, salt: 3300, commAgeSec: 10 }), T + 20 * 60000);
        expect(lines()).toEqual([]);   // written only when the hour is over
        log.record(sample({}), T + H);
        const [h] = lines();
        expect(h).toEqual({ t: '2026-07-01T12:00:00.000Z', id: 1, n: 3, on: 2, out: 50, max: 100, set: 60, tgt: 60, salt: 3300, st: [2], age: 30 });
    });
    it('keeps one line per chlorinator, and a later sample from any of them ends the hour for all', () => {
        log.record(sample({ id: 1 }), T);
        log.record(sample({ id: 2, output: 80 }), T + 60000);
        log.record(sample({ id: 1 }), T + H);
        const ls = lines();
        expect(ls.map(l => l.id).sort()).toEqual([1, 2]);
        expect(ls.find(l => l.id === 2).out).toBe(80);
    });
    it('writes the partial hours at flush and tells the listener', () => {
        const seen: ChlorinatorOutputHour[] = [];
        log.onHour = h => seen.push(h);
        log.record(sample({}), T);
        log.flush();
        expect(lines()).toHaveLength(1);
        expect(seen).toHaveLength(1);
        log.flush();
        expect(lines()).toHaveLength(1);   // nothing left to write
    });
    it('ignores a sample without an id or a numeric output', () => {
        log.record({ ...sample({}), id: undefined } as any, T);
        log.record(sample({ output: NaN }), T);
        log.flush();
        expect(lines()).toEqual([]);
    });
});

describe('ChlorinatorOutputLog.read', () => {
    it('skips a torn line and gives a line without an id to the first chlorinator', () => {
        fs.writeFileSync(file, [
            JSON.stringify({ t: '2026-07-01T10:00:00.000Z', n: 6, on: 6, out: 40, max: 40, set: 40, tgt: 40, salt: 3200 }),
            JSON.stringify({ t: '2026-07-01T11:00:00.000Z', id: 2, n: 6, on: 0, out: 0, max: 0, set: 0, tgt: 0, salt: 0 }),
            '{"t":"2026-07-01T12:0',
        ].join('\n') + '\n');
        expect(log.read(30, T)).toHaveLength(2);
        expect(log.read(30, T, 50, 50)).toHaveLength(1);
        expect(log.read(30, T, 2, 50)).toHaveLength(1);
        expect(idOf(log.read(30, T)[0], 50)).toBe(50);
    });
    it('reads only the last days asked for', () => {
        log.record(sample({}), T - 3 * 86400000);
        log.record(sample({}), T);
        log.flush();
        expect(log.read(2, T + H)).toHaveLength(1);
    });
});

describe('ChlorinatorOutputLog.prune', () => {
    it('drops the hours older than 48 months and keeps the rest', () => {
        const old = new Date(T); old.setMonth(old.getMonth() - 49);
        fs.writeFileSync(file, [
            JSON.stringify({ t: old.toISOString(), id: 1, n: 6, on: 6, out: 40, max: 40, set: 40, tgt: 40, salt: 3200 }),
            JSON.stringify({ t: new Date(T).toISOString(), id: 1, n: 6, on: 6, out: 40, max: 40, set: 40, tgt: 40, salt: 3200 }),
        ].join('\n') + '\n');
        log.prune(T);
        expect(lines().map(l => l.t)).toEqual([new Date(T).toISOString()]);
    });
    it('does not rewrite the file for an hour only just past the cutoff', () => {
        const old = new Date(T); old.setMonth(old.getMonth() - 48); old.setDate(old.getDate() - 10);
        const text = [
            JSON.stringify({ t: old.toISOString(), id: 1, n: 6, on: 6, out: 40, max: 40, set: 40, tgt: 40, salt: 3200 }),
            JSON.stringify({ t: new Date(T).toISOString(), id: 1, n: 6, on: 6, out: 40, max: 40, set: 40, tgt: 40, salt: 3200 }),
        ].join('\n') + '\n';
        fs.writeFileSync(file, text);
        log.prune(T);
        expect(fs.readFileSync(file, 'utf8')).toBe(text);
    });
    it('reads the first and last lines of a file larger than 4 KB', () => {
        const old = new Date(T); old.setMonth(old.getMonth() - 50);
        const ls = [JSON.stringify({ t: old.toISOString(), id: 1, n: 6, on: 6, out: 40, max: 40, set: 40, tgt: 40, salt: 3200 })];
        for (let i = 200; i >= 0; i--) ls.push(JSON.stringify({ t: new Date(T - i * H).toISOString(), id: 1, n: 6, on: 6, out: 40, max: 40, set: 40, tgt: 40, salt: 3200 }));
        fs.writeFileSync(file, ls.join('\n') + '\n');
        expect(fs.statSync(file).size).toBeGreaterThan(8192);
        log.prune(T);
        expect(lines()).toHaveLength(201);
        expect(lines()[0].t).toBe(new Date(T - 200 * H).toISOString());
        // the newest hour came from the end of the file: a sample an hour before it is skipped
        log.record(sample({}), T - H);
        log.flush();
        expect(lines()).toHaveLength(201);
    });
    it('does nothing while the time is before the newest line or looks unset', () => {
        const old = new Date(T); old.setMonth(old.getMonth() - 49);
        const text = [
            JSON.stringify({ t: old.toISOString(), id: 1, n: 6, on: 6, out: 40, max: 40, set: 40, tgt: 40, salt: 3200 }),
            JSON.stringify({ t: new Date(T).toISOString(), id: 1, n: 6, on: 6, out: 40, max: 40, set: 40, tgt: 40, salt: 3200 }),
        ].join('\n') + '\n';
        fs.writeFileSync(file, text);
        log.prune(T - 2 * H);
        expect(fs.readFileSync(file, 'utf8')).toBe(text);
        log.prune(Date.UTC(2020, 0, 1));
        expect(fs.readFileSync(file, 'utf8')).toBe(text);
    });
});

describe('ChlorinatorOutputLog clock guards', () => {
    it('takes no sample while the time looks unset', () => {
        log.record(sample({}), Date.UTC(1970, 0, 2));
        log.record(sample({}), Date.UTC(2024, 11, 31, 23));
        log.flush();
        expect(lines()).toEqual([]);
    });
    it('skips a sample from an hour before the newest one written', () => {
        log.record(sample({}), T);
        log.record(sample({}), T + H);   // writes the T hour
        log.record(sample({}), T - 2 * H);
        log.flush();
        expect(lines().map(l => l.t)).toEqual([new Date(T).toISOString(), new Date(T + H).toISOString()]);
    });
    it('skips it after a restart too, reading the newest hour from the file', () => {
        log.record(sample({}), T);
        log.flush();
        const again = new ChlorinatorOutputLog(file);
        again.record(sample({}), T - 3 * H);
        again.record(sample({}), T + 10 * 60000);   // the same hour as the newest line: kept (a restart within the hour)
        again.flush();
        expect(lines().map(l => l.t)).toEqual([new Date(T).toISOString(), new Date(T).toISOString()]);
    });
    it('takes the time as right when the newest line is more than 7 days ahead of it', () => {
        log.record(sample({}), T);
        log.flush();
        const again = new ChlorinatorOutputLog(file);
        again.record(sample({}), T - 8 * 86400000);
        again.flush();
        expect(lines()).toHaveLength(2);
    });
});

describe('summarizeOutput', () => {
    it('sums the producing time, statuses, stale hours and setpoints', () => {
        const s = summarizeOutput([
            { t: 'a', id: 1, n: 6, on: 3, out: 25, max: 50, set: 50, tgt: 50, salt: 3200 },
            { t: 'b', id: 1, n: 6, on: 6, out: 50, max: 50, set: 50, tgt: 50, salt: 3200, st: [2], age: 1000 },
            { t: 'c', id: 1, n: 6, on: 0, out: 0, max: 0, set: 0, tgt: 0, salt: 3200 },
        ]);
        expect(s.hours).toBe(3);
        expect(s.producingHours).toBe(1.5);
        expect(s.meanOutputWhenOn).toBe(50);
        expect(s.hoursWithStatus).toBe(1);
        expect(s.statuses).toEqual([2]);
        expect(s.hoursStale).toBe(1);
        expect(s.setHistogram).toEqual({ '50': 2, '0': 1 });
        expect(summarizeOutput([])).toBeUndefined();
    });
});
