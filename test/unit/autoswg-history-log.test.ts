// The SWG Assist history log (controller/AutoSwgHistory.ts AutoSwgHistoryLog): one record per line, kept in memory, moved over
// once from the old JSON array, in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { AutoSwgHistoryLog, AutoSwgHistoryRecord } from '../../controller/AutoSwgHistory';

const DAY = 86400000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const rec = (pct: number, appliedAt = ago(1), source: AutoSwgHistoryRecord['source'] = 'auto'): AutoSwgHistoryRecord =>
    ({ source, appliedAt, appliedPct: pct, inputs: { gallons: 15000 }, outputs: { rationale: `set ${pct}` } });
const monthsAgo = (months: number, extraDays = 0) => { const d = new Date(); d.setMonth(d.getMonth() - months); return new Date(d.getTime() - extraDays * DAY).toISOString(); };

let dir: string, jsonl: string, json: string;
const log = () => new AutoSwgHistoryLog(() => dir);
const lines = () => fs.readFileSync(jsonl, 'utf8').split('\n');
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swghist-'));
    jsonl = path.join(dir, 'autoSwgHistory.jsonl');
    json = path.join(dir, 'autoSwgHistory.json');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('AutoSwgHistoryLog', () => {
    it('starts empty with no files, and the first append makes the new file', () => {
        const l = log();
        expect(l.read()).toEqual([]);
        l.append(rec(20));
        expect(lines()).toHaveLength(2);   // one record and the trailing newline
        expect(JSON.parse(lines()[0]).appliedPct).toBe(20);
        expect(fs.existsSync(json)).toBe(false);
    });

    it('appends one line per record and reads them back oldest first, from memory and from the file', () => {
        const l = log();
        l.append(rec(20, ago(3)));
        l.append(rec(25, ago(2), 'manual'));
        const ret = l.append(rec(30, ago(1), 'settings'));
        expect(ret.map(r => r.appliedPct)).toEqual([20, 25, 30]);
        expect(l.read().map(r => r.appliedPct)).toEqual([20, 25, 30]);
        expect(log().read()).toEqual(l.read());
        expect(lines().filter(x => x)).toHaveLength(3);
    });

    it('gives each reader its own array: an earlier read does not change when a record is added, a later one has it', () => {
        const l = log();
        l.append(rec(20));
        const before = l.read();
        before.sort(() => -1).push(rec(99));   // a caller doing what it likes with its copy
        l.append(rec(25));
        expect(before.map(r => r.appliedPct)).toEqual([20, 99]);
        expect(l.read().map(r => r.appliedPct)).toEqual([20, 25]);
    });

    it('loads the file again when something else changed it', () => {
        const l = log();
        l.append(rec(20));
        expect(l.read()).toHaveLength(1);
        fs.writeFileSync(jsonl, JSON.stringify(rec(20)) + '\n' + JSON.stringify(rec(40)) + '\n');
        expect(l.read().map(r => r.appliedPct)).toEqual([20, 40]);
    });

    it('skips a last line cut short, and the next record starts on a line of its own', () => {
        fs.writeFileSync(jsonl, JSON.stringify(rec(20)) + '\n{"source":"auto","appli');
        const l = log();
        expect(l.read().map(r => r.appliedPct)).toEqual([20]);
        l.append(rec(25));
        expect(log().read().map(r => r.appliedPct)).toEqual([20, 25]);
        expect(lines()[1]).toBe('{"source":"auto","appli');
    });

    it('moves the old JSON array over once, checks it, and leaves the old file unchanged', () => {
        const old = [rec(20, ago(40)), rec(25, ago(30), 'manual'), rec(30, ago(20), 'settings')];
        const text = '\uFEFF' + JSON.stringify(old, null, 2);
        fs.writeFileSync(json, text, 'utf8');
        const l = log();
        expect(l.read()).toEqual(old);
        expect(lines().filter(x => x).map(x => JSON.parse(x))).toEqual(old);
        expect(fs.readFileSync(json, 'utf8')).toBe(text);
        expect(fs.existsSync(`${jsonl}.tmp`)).toBe(false);
        l.append(rec(35));
        expect(log().read().map(r => r.appliedPct)).toEqual([20, 25, 30, 35]);
        expect(fs.readFileSync(json, 'utf8')).toBe(text);   // never rewritten after the move
    });

    it('does not move the old file again once the new one exists', () => {
        fs.writeFileSync(json, JSON.stringify([rec(20)]));
        fs.writeFileSync(jsonl, JSON.stringify(rec(50)) + '\n');
        expect(log().read().map(r => r.appliedPct)).toEqual([50]);
    });

    it('makes no new file when the old one cannot be read, and never overwrites it', () => {
        const broken = '[{"source":"auto","appliedAt":"2026-10-01T12:00:00.000Z"},';
        fs.writeFileSync(json, broken);
        const l = log();
        expect(l.read()).toEqual([]);
        expect(l.append(rec(20))).toEqual([]);
        expect(fs.existsSync(jsonl)).toBe(false);
        expect(fs.readFileSync(json, 'utf8')).toBe(broken);
    });

    it('keeps using the old file the old way when the new one cannot be written', () => {
        const old = [rec(20, ago(10))];
        fs.writeFileSync(json, JSON.stringify(old));
        fs.mkdirSync(jsonl);   // a folder where the new file would go: the move's rename fails
        const l = log();
        expect(l.read()).toEqual(old);
        l.append(rec(25));
        expect(JSON.parse(fs.readFileSync(json, 'utf8')).map((r: any) => r.appliedPct)).toEqual([20, 25]);
        expect(l.read().map(r => r.appliedPct)).toEqual([20, 25]);
        expect(fs.existsSync(`${jsonl}.tmp`)).toBe(false);
    });

    it('prunes only once the oldest record is well past the 48-month cutoff, then drops everything past it', () => {
        const justPast = rec(10, monthsAgo(48, 5));
        const recent = rec(20, monthsAgo(47));
        fs.writeFileSync(jsonl, [justPast, recent].map(r => JSON.stringify(r)).join('\n') + '\n');
        const l = log();
        l.append(rec(30));
        expect(log().read().map(r => r.appliedPct)).toEqual([10, 20, 30]);   // 5 days past: not rewritten yet

        fs.writeFileSync(jsonl, [rec(5, monthsAgo(48, 40)), justPast, recent].map(r => JSON.stringify(r)).join('\n') + '\n');
        const m = log();
        m.append(rec(30));
        expect(m.read().map(r => r.appliedPct)).toEqual([20, 30]);
        expect(log().read().map(r => r.appliedPct)).toEqual([20, 30]);
        expect(fs.existsSync(`${jsonl}.tmp`)).toBe(false);
    });
});
