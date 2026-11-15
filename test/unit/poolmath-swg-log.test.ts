// The PoolMath SWG log's rules (controller/PoolMathSwgLog.ts) with a fake PoolMath client and clock: one entry per pool % change once it
// holds, never at a start, super chlorinate as two entries, retries that never log an entry twice, and the status without secrets.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { PoolMathError } from '../../controller/PoolMathClient';
import { HOLD_MS, RETRY_MS, STARTUP_GRACE_MS, swgPpm, SwgLogReading, SwgLogWriter } from '../../controller/PoolMathSwgLog';

const T0 = Date.parse('2026-11-15T12:00:00Z');
const MIN = 60000, H = 3600000;
let dir: string, file: string;
let now: number;
let reading: SwgLogReading;
let settings: { enabled: boolean; hours: number };
let posts: any[];
let fail: (() => Error) | undefined;
let fileFound: boolean;

const client = {
    userId: 'U',
    credentialsFileFound: () => fileFound,
    poolId: async () => 'pool-1',
    ensureSession: async () => ({ userId: 'U', token: 'T' }),
    request: async (method: string, route: string, body: any) => {
        if (fail) throw fail();
        posts.push(body);
        return { log: { id: `id-${posts.length}` } };
    },
    lastSignInAt: undefined as number | undefined,
    lastSignInError: undefined as string | undefined,
};
function writer() {
    const w = new SwgLogWriter({ client: client as any, settings: () => settings, reading: () => reading, file, now: () => now });
    w.start();
    return w;
}
// Runs the 15-second check for `ms`.
async function run(w: SwgLogWriter, ms: number) {
    const end = now + ms;
    while (now < end) { now += 15000; await w.tick(); }
}
const pctReading = (pct: number, extra: Partial<SwgLogReading> = {}): SwgLogReading => ({ ok: true, percent: pct, superChlorOn: false, lbsPerDay: 1.47, gallons: 12000, ...extra });

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmswg-'));
    file = path.join(dir, 'poolMathSwgLog.json');
    now = T0;
    reading = pctReading(34);
    settings = { enabled: true, hours: 9 };
    posts = [];
    fail = undefined;
    fileFound = true;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('swgPpm', () => {
    it('works out FC as the web app does', () => {
        expect(swgPpm(1.47, 34, 9, 12000)).toBe(1.9);
        expect(swgPpm(1.47, 100, 8, 12000)).toBe(4.9);
        expect(swgPpm(0, 34, 9, 12000)).toBe(0);
    });
});

describe('pool % changes', () => {
    it('writes nothing at a start, even when the % differs from the last one logged', async () => {
        let w = writer();
        await run(w, STARTUP_GRACE_MS + 5 * MIN);
        reading = pctReading(40);           // changed while njsPC was stopped
        w = writer();
        await run(w, STARTUP_GRACE_MS + 10 * MIN);
        expect(posts).toEqual([]);
        expect(w.status().baselinePercent).toBe(40);
    });
    it('writes one entry, timed at the change, once the % has held for two minutes', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        reading = pctReading(30);
        const changedAt = now + 15000;
        await run(w, HOLD_MS - 15000);
        expect(posts).toEqual([]);
        await run(w, 30000);
        expect(posts.length).toBe(1);
        expect(posts[0]).toMatchObject({ Chemical: 27, Percent: 30, runTime: 9, Amount: swgPpm(1.47, 30, 9, 12000), poolId: 'pool-1', userId: 'U' });
        expect(posts[0].logTimestamp).toBe(new Date(changedAt).toISOString().replace('.000Z', 'Z'));
        await run(w, 30 * MIN);
        expect(posts.length).toBe(1);
    });
    it('collapses quick changes into one entry at the final %', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        reading = pctReading(30); await run(w, 30000);
        reading = pctReading(32); await run(w, 30000);
        await run(w, HOLD_MS + MIN);
        expect(posts.map(p => p.Percent)).toEqual([32]);
    });
    it('writes nothing when a change is undone within two minutes, or the same % is saved again', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        reading = pctReading(40); await run(w, MIN);
        reading = pctReading(34); await run(w, 10 * MIN);
        expect(posts).toEqual([]);
    });
    it('does not write twice across a restart', async () => {
        let w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        reading = pctReading(30);
        await run(w, HOLD_MS + MIN);
        expect(posts.length).toBe(1);
        w = writer();
        await run(w, STARTUP_GRACE_MS + 10 * MIN);
        expect(posts.length).toBe(1);
    });
    it('writes nothing without the run hours, and does not catch up when they are set', async () => {
        settings.hours = 0;
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        reading = pctReading(30); await run(w, HOLD_MS + MIN);
        expect(posts).toEqual([]);
        expect(w.status().note).toMatch(/run hours/);
        settings.hours = 9;
        await run(w, 10 * MIN);
        expect(posts).toEqual([]);
    });
    it('writes nothing while off, and turning it on only sets the starting point', async () => {
        settings.enabled = false;
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        reading = pctReading(30); await run(w, HOLD_MS + MIN);
        settings.enabled = true;
        await run(w, 10 * MIN);
        expect(posts).toEqual([]);
        reading = pctReading(28); await run(w, HOLD_MS + MIN);
        expect(posts.map(p => p.Percent)).toEqual([28]);
    });
    it('writes nothing when the reading is not usable (more than one chlorinator)', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        reading = { ok: false, reason: 'PoolMath SWG entries are written only when there is one chlorinator.' };
        await run(w, 10 * MIN);
        expect(posts).toEqual([]);
        expect(w.status().note).toMatch(/one chlorinator/);
    });
    it('a change during super chlorinate writes nothing by itself', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        reading = pctReading(30, { superChlorOn: true });
        await run(w, 30 * MIN);
        expect(posts).toEqual([]);
    });
});

describe('super chlorinate', () => {
    it('writes 100% for the powered hours at the start, then the pool % at the end', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        const start = now - 8 * H;
        reading = pctReading(30);   // the % was changed during the run
        w.superChlorEnded({ id: 50, start, end: now, reason: 'timer', hours: 8, poweredHours: 7.6, atStartup: false });
        await run(w, 30000);
        expect(posts.map(p => [p.Percent, p.runTime, p.Amount, p.logTimestamp])).toEqual([
            [100, 8, swgPpm(1.47, 100, 7.6, 12000), new Date(start).toISOString().replace('.000Z', 'Z')],
            [30, 9, swgPpm(1.47, 30, 9, 12000), expect.any(String)],
        ]);
        await run(w, 10 * MIN);
        expect(posts.length).toBe(2);   // the % after the run is the starting point: no extra change entry
    });
    it('writes nothing to PoolMath for a run with under half an hour of power', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        w.superChlorEnded({ id: 50, start: now - 10 * MIN, end: now, reason: 'turnedOff', hours: 0.17, poweredHours: 0.17, atStartup: false });
        await run(w, 5 * MIN);
        expect(posts).toEqual([]);
    });
    it('a run that ended while njsPC was stopped is written after the start settles', async () => {
        const w = writer();
        w.superChlorEnded({ id: 50, start: now - 6 * H, end: now - 2 * H, reason: 'stopped', hours: 4, poweredHours: 4, atStartup: true });
        await run(w, STARTUP_GRACE_MS - 30000);
        expect(posts).toEqual([]);
        await run(w, MIN);
        expect(posts.map(p => p.Percent)).toEqual([100, 34]);
    });
});

describe('failures', () => {
    it('retries an entry PoolMath refused every 15 minutes, keeping its time', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        fail = () => new PoolMathError('POST /chemlogs -> HTTP 503', 503);
        reading = pctReading(30);
        await run(w, HOLD_MS + MIN);
        expect(w.status().pending).toBe(1);
        expect(w.status().lastError).toMatch(/503/);
        fail = undefined;
        await run(w, RETRY_MS - 2 * MIN);
        expect(posts).toEqual([]);
        await run(w, 3 * MIN);
        expect(posts.map(p => p.Percent)).toEqual([30]);
        expect(w.status().pending).toBe(0);
        expect(w.status().lastError).toBeUndefined();
    });
    it('keeps a waiting entry across a restart and sends it later', async () => {
        let w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        fail = () => new PoolMathError('could not reach PoolMath (ENOTFOUND)');
        reading = pctReading(30);
        await run(w, HOLD_MS + MIN);
        fail = undefined;
        w = writer();
        await run(w, STARTUP_GRACE_MS + RETRY_MS);
        expect(posts.map(p => p.Percent)).toEqual([30]);
    });
    it('never resends a request that may have reached PoolMath', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        fail = () => new PoolMathError('POST /chemlogs: no answer from PoolMath (TimeoutError)', undefined, true);
        reading = pctReading(30);
        await run(w, HOLD_MS + MIN);
        fail = undefined;
        await run(w, 2 * H);
        expect(posts).toEqual([]);
        expect(w.status().pending).toBe(0);
        expect(w.status().lastError).toMatch(/check PoolMath/);
    });
    it('drops an entry that could not be written for a day', async () => {
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        fail = () => new PoolMathError('The last PoolMath sign-in failed 1 min ago; waiting before trying again.', undefined, false, true);
        reading = pctReading(30);
        await run(w, HOLD_MS + MIN);
        now += 25 * H;
        await w.tick();
        expect(w.status().pending).toBe(0);
        expect(w.status().lastError).toMatch(/dropped/);
    });
});

describe('status', () => {
    it('shows the credentials file, the last sign-in and the last error, never a secret', async () => {
        client.lastSignInAt = T0;
        const w = writer();
        await run(w, STARTUP_GRACE_MS + MIN);
        reading = pctReading(30);
        await run(w, HOLD_MS + MIN);
        const s = w.status();
        expect(s).toMatchObject({ enabled: true, hoursPerDay: 9, credentialsFile: 'found', lastSignIn: { ok: true }, pending: 0, lastWritten: { percent: 30, hours: 9 } });
        expect(JSON.stringify(s)).not.toMatch(/token|password|pwd|"T"/i);
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(/token|password|pwd/i);
        client.lastSignInAt = undefined;
        fileFound = false;
        expect(writer().status()).toMatchObject({ credentialsFile: 'missing', note: expect.stringMatching(/credentials file/) });
    });
});
