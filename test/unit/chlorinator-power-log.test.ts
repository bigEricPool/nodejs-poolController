// The chlorinator power log (controller/ChlorinatorPowerLog.ts), written to a temporary file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { ChlorinatorPowerLog } from '../../controller/ChlorinatorPowerLog';

const T = Date.parse('2026-11-08T12:00:00.000Z');
const H = 3600000;
let dir: string, file: string, log: ChlorinatorPowerLog;
const lines = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chlorpower-'));
    file = path.join(dir, 'chlorinatorPowerLog.jsonl');
    log = new ChlorinatorPowerLog(file);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('ChlorinatorPowerLog.record', () => {
    it('writes the first state, then only the changes', () => {
        expect(log.record(1, true, T)).toBeDefined();
        expect(log.record(1, true, T + 15000)).toBeUndefined();
        expect(log.record(1, false, T + H)).toBeDefined();
        expect(log.record(2, false, T + H)).toBeDefined();
        expect(lines()).toEqual([
            { t: new Date(T).toISOString(), id: 1, on: true },
            { t: new Date(T + H).toISOString(), id: 1, on: false },
            { t: new Date(T + H).toISOString(), id: 2, on: false },
        ]);
    });
    it('reads the last state back after a restart', () => {
        log.record(1, true, T);
        const again = new ChlorinatorPowerLog(file);
        expect(again.lastEvent(1)).toEqual({ t: new Date(T).toISOString(), id: 1, on: true });
        expect(again.record(1, true, T + H)).toBeUndefined();
    });
    it('writes nothing while the time looks unset or is before the newest event', () => {
        expect(log.record(1, true, Date.UTC(2020, 0, 1))).toBeUndefined();
        log.record(1, true, T);
        expect(log.record(1, false, T - H)).toBeUndefined();
        expect(lines()).toHaveLength(1);
        expect(log.record(1, false, T + 60000)).toBeDefined();
    });
});

describe('ChlorinatorPowerLog.read', () => {
    it('returns the span asked for with the event before it', () => {
        log.record(1, true, T - 5 * 86400000);
        log.record(1, false, T - 4 * 86400000);
        log.record(1, true, T - H);
        log.record(2, true, T - H);
        expect(log.read(2, T, 1).map(e => e.on)).toEqual([false, true]);
        expect(log.read(2, T).map(e => e.id)).toEqual([1, 1, 2]);
    });
});

describe('ChlorinatorPowerLog.prune', () => {
    it('drops the events past the cutoff but keeps the state at the cutoff', () => {
        const ago = (months: number) => { const d = new Date(T); d.setMonth(d.getMonth() - months); return d.toISOString(); };
        const recent = new Date(T - 86400000).toISOString();
        fs.writeFileSync(file, [
            { t: ago(50), id: 1, on: true }, { t: ago(49), id: 1, on: false }, { t: recent, id: 1, on: true },
        ].map(e => JSON.stringify(e)).join('\n') + '\n');
        log.prune(T);
        expect(lines().map(e => e.on)).toEqual([false, true]);
    });
});
