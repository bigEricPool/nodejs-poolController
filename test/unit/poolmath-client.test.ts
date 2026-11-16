// The PoolMath client (controller/PoolMathClient.ts) against a fake fetch: the encrypted credentials file in the rig's format, sign-in on
// first use with the token in memory only, re-sign-in once on a 401, one sign-in at a time, the back-off after a failed sign-in, the short
// retry for a brand-new token, and the SWG chemlog's shape.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPoolMathCredentials, PoolMathClient, PoolMathError, poolMathTimestamp, swgChemlog } from '../../controller/PoolMathClient';

const MACHINE = 'test-machine-id-0123456789abcdef';
const USER_ID = 'AbCdEfGhIj';
const TOKEN = '11111111-2222-3333-4444-555555555555';

// Writes a credentials file exactly as the README's one-line command does.
function writeCreds(file: string, u: string, pw: string, machine = MACHINE) {
    const s = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const k = crypto.scryptSync(machine + '\0', s, 32, { N: 32768, r: 8, p: 1, maxmem: 67108864 });
    const x = crypto.createCipheriv('aes-256-gcm', k, iv);
    const d = Buffer.concat([x.update(JSON.stringify({ u, pw }), 'utf8'), x.final()]);
    fs.writeFileSync(file, JSON.stringify({ v: 1, p: false, s: s.toString('base64'), i: iv.toString('base64'), t: x.getAuthTag().toString('base64'), d: d.toString('base64') }));
}

interface Call { method: string; url: string; headers: any; body: any; }
type Handler = (c: Call) => { status: number; body?: any } | Promise<{ status: number; body?: any }> | 'network' | 'timeout';
function fakeFetch(handler: Handler) {
    const calls: Call[] = [];
    const fn = async (url: string, init: any = {}) => {
        const c: Call = { method: init.method || 'GET', url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
        calls.push(c);
        const r = await handler(c);
        if (r === 'network') { const e: any = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
        if (r === 'timeout') { const e: any = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
        const text = typeof r.body === 'undefined' ? '' : JSON.stringify(r.body);
        return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text } as any;
    };
    return { fn, calls };
}
const basic = (u: string, t: string) => 'Basic ' + Buffer.from(`${u}:${t}`).toString('base64');
const authOk = { status: 200, body: { userId: USER_ID, id: 'x', authorizations: [{ name: 'n', token: TOKEN, timestamp: 1 }] } };
const prefsOk = { status: 200, body: { defPoolId: 'pool-1' } };

let dir: string, file: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmclient-'));
    file = path.join(dir, 'state.dat');
    writeCreds(file, 'owner@example.com', 'secret-pw');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function client(f: ReturnType<typeof fakeFetch>, extra: any = {}) {
    return new PoolMathClient({ credentialsFile: file, fetch: f.fn as any, machineId: () => MACHINE, probeWaitsMs: [0, 1, 1], ...extra });
}

describe('credentials file', () => {
    it('decrypts the rig\'s format', async () => {
        expect(await loadPoolMathCredentials(file, () => MACHINE)).toEqual({ u: 'owner@example.com', pw: 'secret-pw' });
    });
    it('cannot be opened on another machine, and the error has no secrets', async () => {
        const err = await loadPoolMathCredentials(file, () => 'other-machine').catch(e => e);
        expect(err.message).toMatch(/could not be decrypted/);
        expect(err.message).not.toMatch(/owner|secret/);
    });
    it('says when there is no file', async () => {
        await expect(loadPoolMathCredentials(path.join(dir, 'none'), () => MACHINE)).rejects.toThrow(/No PoolMath credentials file/);
    });
});

describe('sign-in', () => {
    it('signs in on first use as the web app does, then reuses the token', async () => {
        const f = fakeFetch((c) => {
            if (c.url.endsWith('/auth')) return authOk;
            if (c.url.endsWith('/userprefs/refresh')) return prefsOk;
            return { status: 200, body: { log: { id: 'log-1' } } };
        });
        const cl = client(f);
        expect(await cl.poolId()).toBe('pool-1');
        await cl.request('POST', 'chemlogs', { a: 1 });
        await cl.request('POST', 'chemlogs', { a: 2 });
        const auth = f.calls.filter(c => c.url.endsWith('/auth'));
        expect(auth.length).toBe(1);
        expect(auth[0].method).toBe('POST');
        expect(auth[0].headers.Authorization).toBeUndefined();
        expect(auth[0].body).toEqual({ provider: 'tfp', token: null, user: 'owner@example.com', pwd: 'secret-pw', device: expect.any(String) });
        for (const c of f.calls.filter(c => !c.url.endsWith('/auth'))) expect(c.headers.Authorization).toBe(basic(USER_ID, TOKEN));
        expect(f.calls.filter(c => c.url.endsWith('/chemlogs')).length).toBe(2);
        expect(cl.lastSignInAt).toBeGreaterThan(0);
        expect(cl.lastSignInError).toBeUndefined();
    });
    it('signs in once for requests made at the same time', async () => {
        const f = fakeFetch(async (c) => {
            if (c.url.endsWith('/auth')) { await new Promise(r => setTimeout(r, 20)); return authOk; }
            if (c.url.endsWith('/userprefs/refresh')) return prefsOk;
            return { status: 200, body: {} };
        });
        const cl = client(f);
        await Promise.all([cl.request('GET', 'a'), cl.request('GET', 'b'), cl.request('GET', 'c')]);
        expect(f.calls.filter(c => c.url.endsWith('/auth')).length).toBe(1);
    });
    it('waits for a brand-new token that is refused at first', async () => {
        let probes = 0;
        const f = fakeFetch((c) => {
            if (c.url.endsWith('/auth')) return authOk;
            if (c.url.endsWith('/userprefs/refresh')) return ++probes < 3 ? { status: 401 } : prefsOk;
            return { status: 200 };
        });
        expect(await client(f).poolId()).toBe('pool-1');
        expect(probes).toBe(3);
    });
    it('on a 401 signs in again once and retries the request once', async () => {
        let posts = 0;
        const f = fakeFetch((c) => {
            if (c.url.endsWith('/auth')) return authOk;
            if (c.url.endsWith('/userprefs/refresh')) return prefsOk;
            return ++posts === 1 ? { status: 401 } : { status: 200, body: { log: { id: 'x' } } };
        });
        const cl = client(f);
        expect(await cl.request('POST', 'chemlogs', {})).toEqual({ log: { id: 'x' } });
        expect(f.calls.filter(c => c.url.endsWith('/auth')).length).toBe(2);
        expect(posts).toBe(2);
    });
    it('does not loop when the retry is refused too', async () => {
        const f = fakeFetch((c) => {
            if (c.url.endsWith('/auth')) return authOk;
            if (c.url.endsWith('/userprefs/refresh')) return prefsOk;
            return { status: 401 };
        });
        const err = await client(f).request('POST', 'chemlogs', {}).catch(e => e);
        expect(err).toBeInstanceOf(PoolMathError);
        expect(err.status).toBe(401);
        expect(f.calls.filter(c => c.url.endsWith('/chemlogs')).length).toBe(2);
    });
    it('waits 15 minutes after a failed sign-in, and the error has no secrets', async () => {
        let now = Date.parse('2026-11-15T12:00:00Z');
        const f = fakeFetch((c) => c.url.endsWith('/auth') ? { status: 400, body: { message: 'bad' } } : prefsOk);
        const cl = client(f, { now: () => now });
        const e1 = await cl.request('GET', 'x').catch(e => e);
        expect(e1.message).toMatch(/sign-in failed \(HTTP 400\)/);
        expect(e1.message).not.toMatch(/owner|secret/);
        expect(cl.lastSignInError).toBeDefined();
        now += 14 * 60 * 1000;
        const e2 = await cl.request('GET', 'x').catch(e => e);
        expect(e2.message).toMatch(/waiting before trying again/);
        expect(f.calls.filter(c => c.url.endsWith('/auth')).length).toBe(1);
        now += 2 * 60 * 1000;
        await cl.request('GET', 'x').catch(e => e);
        expect(f.calls.filter(c => c.url.endsWith('/auth')).length).toBe(2);
    });
    it('a missing credentials file is a sign-in failure without a request', async () => {
        const f = fakeFetch(() => authOk);
        const cl = new PoolMathClient({ credentialsFile: path.join(dir, 'none'), fetch: f.fn as any, machineId: () => MACHINE });
        expect(cl.credentialsFileFound()).toBe(false);
        await expect(cl.poolId()).rejects.toThrow(/No PoolMath credentials file/);
        expect(f.calls.length).toBe(0);
    });
});

describe('network errors', () => {
    it('a request that never left can be retried', async () => {
        let first = true;
        const f = fakeFetch((c) => {
            if (c.url.endsWith('/auth')) return authOk;
            if (c.url.endsWith('/userprefs/refresh')) return prefsOk;
            if (first) { first = false; return 'network'; }
            return { status: 200 };
        });
        const cl = client(f);
        await cl.poolId();
        const err = await cl.request('POST', 'chemlogs', {}).catch(e => e);
        expect(err.maybeSent).toBe(false);
    });
    it('a timeout may have reached PoolMath', async () => {
        const f = fakeFetch((c) => c.url.endsWith('/auth') ? authOk : c.url.endsWith('/userprefs/refresh') ? prefsOk : 'timeout');
        const cl = client(f);
        const err = await cl.request('POST', 'chemlogs', {}).catch(e => e);
        expect(err.maybeSent).toBe(true);
    });
});

describe('swgChemlog', () => {
    it('matches the web app\'s SWG entry', () => {
        const ts = Date.parse('2026-11-15T14:03:27.456Z');
        expect(poolMathTimestamp(ts)).toBe('2026-11-15T14:03:27Z');
        expect(swgChemlog({ poolId: 'p', userId: 'u', ts, percent: 34, hours: 9, ppm: 1.9 })).toEqual({
            type: 'chemlog', Chemical: 27, runTime: 9, Percent: 34, Unit: 8, Amount: 1.9, NormalizedAmount: 1.9,
            poolId: 'p', logTimestamp: '2026-11-15T14:03:27Z', weather: null, weatherLogId: null, userId: 'u', origin: null, id: null,
            _ts: -62135596800, deleted: false
        });
    });
});
