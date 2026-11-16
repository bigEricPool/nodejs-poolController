// The chlorinator comms log (controller/ChlorinatorCommsLog.ts): the RS-485 port of each chlorinator and, while its power relays are on,
// whether it answers. The tracker decides the lines from each 2-second check; the log writes them to a temporary file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { ChlorinatorCommsLog, CommsReading, CommsTracker } from '../../controller/ChlorinatorCommsLog';

const S = 1000;
const T = Date.parse('2026-11-16T12:00:00.000Z');
const TIMING = { freshSec: 30, graceSec: 30 };
const r = (o: Partial<CommsReading>): CommsReading => ({ id: 50, portOpen: true, portError: false, relaysOn: false, ...o });

// Runs checks every 2 s from `from` to `to` with the reading given by `at`, and returns the lines.
function run(tr: CommsTracker, from: number, to: number, at: (t: number) => Partial<CommsReading>) {
    const out: any[] = [];
    for (let t = from; t <= to; t += 2 * S) { const e = tr.check(r(at(t)), t); if (e) out.push(e); }
    return out;
}

describe('CommsTracker: the port', () => {
    it('writes the state when the log begins, then only changes', () => {
        const tr = new CommsTracker(TIMING);
        expect(run(tr, T, T + 60 * S, () => ({}))).toEqual([{ t: new Date(T).toISOString(), id: 50, port: 'ok' }]);
    });
    it('a start whose last line says the same writes nothing', () => {
        const tr = new CommsTracker(TIMING, () => 'ok');
        expect(run(tr, T, T + 20 * S, () => ({}))).toEqual([]);
    });
    it('an inactivity reopen (closed at one check) is not a change; closed at two in a row is "down", then "ok" when it opens', () => {
        const tr = new CommsTracker(TIMING, () => 'ok');
        expect(run(tr, T, T + 20 * S, t => ({ portOpen: t !== T + 10 * S }))).toEqual([]);
        const lines = run(tr, T + 22 * S, T + 60 * S, t => ({ portOpen: !(t >= T + 30 * S && t < T + 42 * S) }));
        expect(lines).toEqual([
            { t: new Date(T + 32 * S).toISOString(), id: 50, port: 'down' },
            { t: new Date(T + 42 * S).toISOString(), id: 50, port: 'ok' },
        ]);
    });
    it('njsPC\'s "port disconnected" message is "down" at once', () => {
        const tr = new CommsTracker(TIMING, () => 'ok');
        expect(tr.check(r({ portOpen: false, portError: true }), T)).toEqual({ t: new Date(T).toISOString(), id: 50, port: 'down' });
    });
    it('is followed at night too (relays off), with no answering', () => {
        const tr = new CommsTracker(TIMING, () => 'ok');
        const lines = run(tr, T, T + 20 * S, t => ({ relaysOn: false, portOpen: t < T + 6 * S }));
        expect(lines).toEqual([{ t: new Date(T + 8 * S).toISOString(), id: 50, port: 'down' }]);
    });
    it('no port (or a disabled one): nothing', () => {
        const tr = new CommsTracker(TIMING);
        expect(tr.check(r({ portOpen: undefined }), T)).toBeUndefined();
    });
});

describe('CommsTracker: answering while the relays are on', () => {
    const ON = T;
    it('a cell that answers: no line', () => {
        const tr = new CommsTracker(TIMING, () => 'ok');
        expect(run(tr, ON, ON + 10 * 60 * S, t => ({ relaysOn: true, relaysOnSince: ON, lastComm: t > ON + 5 * S ? t - S : undefined }))).toEqual([]);
    });
    it('silent past the grace: "false" after 30 s more of silence, "true" at the first answer', () => {
        const tr = new CommsTracker(TIMING, () => 'ok');
        const answerAt = ON + 5 * 60 * S;
        const lines = run(tr, ON, ON + 6 * 60 * S, t => ({ relaysOn: true, relaysOnSince: ON, lastComm: t >= answerAt ? t : ON - 12 * 3600 * S }));
        expect(lines).toEqual([
            { t: new Date(ON + 62 * S).toISOString(), id: 50, port: 'ok', answering: false },
            { t: new Date(answerAt).toISOString(), id: 50, port: 'ok', answering: true },
        ]);
    });
    it('a cell that stops answering in the day (11-16 12:21-12:45): one line each way', () => {
        const tr = new CommsTracker(TIMING, () => 'ok');
        const stop = ON + 3600 * S, back = stop + 24 * 60 * S;
        const lines = run(tr, ON, back + 60 * S, t => ({ relaysOn: true, relaysOnSince: ON, lastComm: t < stop || t >= back ? t : stop }));
        expect(lines.map(l => [l.t, l.answering])).toEqual([[new Date(stop + 32 * S).toISOString(), false], [new Date(back).toISOString(), true]]);
    });
    it('relays off: not followed, and the next relays-on period starts fresh', () => {
        const tr = new CommsTracker(TIMING, () => 'ok');
        expect(run(tr, ON, ON + 30 * 60 * S, () => ({ relaysOn: false, lastComm: ON - 3600 * S }))).toEqual([]);
        const on2 = ON + 40 * 60 * S;
        expect(run(tr, on2, on2 + 20 * S, t => ({ relaysOn: true, relaysOnSince: on2, lastComm: ON - 3600 * S }))).toEqual([]);   // in the grace
    });
    it('after the port comes back, the cell has the fresh time to answer before it counts as silent', () => {
        const tr = new CommsTracker(TIMING, () => 'ok');
        const down = ON + 10 * 60 * S, up = down + 60 * S;
        const lines = run(tr, ON, up + 60 * S, t => ({ relaysOn: true, relaysOnSince: ON, portOpen: !(t >= down && t < up), lastComm: t < down ? t : (t >= up + 4 * S ? t : down) }));
        expect(lines.map(l => [l.port, l.answering])).toEqual([['down', undefined], ['ok', true]]);
    });
});

describe('ChlorinatorCommsLog', () => {
    let dir: string, file: string, log: ChlorinatorCommsLog;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chlorcomms-'));
        file = path.join(dir, 'chlorinatorCommsLog.jsonl');
        log = new ChlorinatorCommsLog(file);
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    it('appends lines, and keeps the newest per chlorinator', () => {
        expect(log.write({ t: new Date(T).toISOString(), id: 50, port: 'ok' })).toBe(true);
        expect(log.write({ t: new Date(T + 60 * S).toISOString(), id: 50, port: 'ok', answering: false })).toBe(true);
        expect(new ChlorinatorCommsLog(file).lastEvent(50)).toEqual({ t: new Date(T + 60 * S).toISOString(), id: 50, port: 'ok', answering: false });
        expect(log.read(1, T + 120 * S, 50)).toHaveLength(2);
    });
    it('writes nothing while the time looks unset or before the newest line', () => {
        expect(log.write({ t: new Date(Date.UTC(2020, 0, 1)).toISOString(), id: 50, port: 'down' })).toBe(false);
        log.write({ t: new Date(T).toISOString(), id: 50, port: 'ok' });
        expect(log.write({ t: new Date(T - 60 * S).toISOString(), id: 50, port: 'down' })).toBe(false);
        expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    });
});
