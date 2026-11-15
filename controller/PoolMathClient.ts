/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026.
Russell Goldin, tagyoureit.  russ.goldin@gmail.com

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// A client for the pool owner's own PoolMath account, for writing log entries (PoolMathSwgLog.ts). PoolMath publishes no API: this uses
// the api.poolmathapp.com endpoints the Pool Math web app uses (captured 2026-11-15), the same as the poolmath-rig test script.
//
// Credentials: an encrypted file the owner creates once on the controller (default ~/.local/share/lumen/state.dat, or the path in the
// POOLMATH_CREDENTIALS environment variable), JSON {v, p, s, i, t, d}: AES-256-GCM over {"u": username, "pw": password}, key =
// scrypt(machine id + "\0", salt s, 32 bytes, N=32768 r=8 p=1). There is no passphrase (p is always false), so njsPC can sign in unattended;
// a copy of the file is useless on another computer. The username, password and token are never written to config.json, poolConfig.json,
// poolState.json or the log, and never sent anywhere but PoolMath's sign-in.
//
// Sign-in: on first use; the file is read only then and the password is not kept. The token is kept in memory only and reused; on a 401
// the client signs in once more and retries the request once. Only one sign-in runs at a time, and after a failed sign-in it waits
// SIGN_IN_BACKOFF_MS before trying again, so a wrong password cannot hammer PoolMath.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

export const POOLMATH_API = 'https://api.poolmathapp.com';
export const SIGN_IN_BACKOFF_MS = 15 * 60 * 1000;
export const CHEM_SWG = 27;    // PoolMath's chemical id for an SWG run (as in the share feed)
export const UNIT_PPM = 8;     // the unit the web app sends with an SWG entry's FC amount

export function defaultCredentialsPath(): string {
    return process.env.POOLMATH_CREDENTIALS || path.join(os.homedir(), '.local', 'share', 'lumen', 'state.dat');
}

export function machineId(): string {
    try {
        if (process.platform === 'win32') {
            const out = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', { encoding: 'utf8' });
            const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-f-]+)/i);
            if (m) return m[1];
        } else if (process.platform === 'darwin') {
            const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf8' });
            const m = out.match(/"IOPlatformUUID" = "([^"]+)"/);
            if (m) return m[1];
        } else {
            for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
                if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
            }
        }
    } catch (err) { /* fall through */ }
    throw new Error('Could not read a machine id to open the PoolMath credentials file.');
}

function scryptAsync(secret: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => crypto.scrypt(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key)));
}

// Reads and decrypts the credentials file. Errors never include the file's contents.
export async function loadPoolMathCredentials(file: string, idOf: () => string = machineId): Promise<{ u: string; pw: string }> {
    if (!fs.existsSync(file)) throw new Error('No PoolMath credentials file has been created on this controller.');
    let parsed: any;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error('The PoolMath credentials file could not be read.'); }
    if (!parsed || parsed.p) throw new Error('The PoolMath credentials file was made with a passphrase, which is not supported; create it again.');
    let creds: any;
    try {
        const key = await scryptAsync(idOf() + '\0', Buffer.from(parsed.s, 'base64'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.i, 'base64'));
        decipher.setAuthTag(Buffer.from(parsed.t, 'base64'));
        creds = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parsed.d, 'base64')), decipher.final()]).toString('utf8'));
    } catch (err) {
        throw new Error('The PoolMath credentials file could not be decrypted (it was made on another computer, or it is damaged).');
    }
    if (!creds || typeof creds.u !== 'string' || typeof creds.pw !== 'string' || !creds.u || !creds.pw) throw new Error('The PoolMath credentials file has no username and password.');
    return { u: creds.u, pw: creds.pw };
}

// An error from a request. `status` is the HTTP status when PoolMath answered. `maybeSent` is true when the request may have reached
// PoolMath and no answer came back (a timeout or a dropped connection), so retrying it could log the entry twice.
export class PoolMathError extends Error {
    constructor(message: string, public status?: number, public maybeSent: boolean = false, public signIn: boolean = false) { super(message); }
}

// Connection errors that happen before anything is sent, so a retry is safe.
const NOT_SENT_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'];
function networkError(err: any, what: string): PoolMathError {
    const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
    const notSent = NOT_SENT_CODES.indexOf(code) !== -1;
    return new PoolMathError(`${what}: ${notSent ? `could not reach PoolMath (${code})` : `no answer from PoolMath (${code || (err && err.name) || 'network error'})`}`, undefined, !notSent);
}

export interface PoolMathClientOptions {
    credentialsFile?: string;
    fetch?: typeof fetch;
    machineId?: () => string;
    signInBackoffMs?: number;
    probeWaitsMs?: number[];       // waits before checking a brand-new token (it was once refused straight after sign-in)
    timeoutMs?: number;
    userAgent?: string;
    device?: string;
    now?: () => number;
}

export class PoolMathClient {
    private session: { userId: string; token: string; poolId?: string } | null = null;
    private signingIn: Promise<{ userId: string; token: string; poolId?: string }> | null = null;
    private lastSignInFailure = 0;
    public lastSignInAt?: number;      // the last successful sign-in
    public lastSignInError?: string;   // the last failed sign-in's reason (undefined after a success)
    private readonly opts: Required<Omit<PoolMathClientOptions, 'credentialsFile'>> & { credentialsFile?: string };

    constructor(opts: PoolMathClientOptions = {}) {
        this.opts = {
            credentialsFile: opts.credentialsFile,
            fetch: opts.fetch || ((...args: Parameters<typeof fetch>) => fetch(...args)),
            machineId: opts.machineId || machineId,
            signInBackoffMs: opts.signInBackoffMs ?? SIGN_IN_BACKOFF_MS,
            probeWaitsMs: opts.probeWaitsMs || [0, 2000, 5000],
            timeoutMs: opts.timeoutMs ?? 30000,
            userAgent: opts.userAgent || 'nodejs-poolController (PoolMath SWG log)',
            device: opts.device || `nodejs-poolController (${os.hostname()})`,
            now: opts.now || Date.now
        };
    }
    public credentialsFile(): string { return this.opts.credentialsFile || defaultCredentialsPath(); }
    public credentialsFileFound(): boolean { try { return fs.existsSync(this.credentialsFile()); } catch (err) { return false; } }
    public get signedIn(): boolean { return !!this.session; }
    public get userId(): string | undefined { return this.session ? this.session.userId : undefined; }
    // Forgets the token (it is in memory only); the next request signs in again.
    public signOut() { this.session = null; }

    public async ensureSession(): Promise<{ userId: string; token: string; poolId?: string }> {
        if (this.session) return this.session;
        if (!this.signingIn) {
            const since = this.opts.now() - this.lastSignInFailure;
            if (this.lastSignInFailure && since < this.opts.signInBackoffMs)
                throw new PoolMathError(`The last PoolMath sign-in failed ${Math.round(since / 60000)} min ago; waiting before trying again.`, undefined, false, true);
            this.signingIn = this.signIn()
                .then((s) => { this.session = s; this.lastSignInAt = this.opts.now(); this.lastSignInError = undefined; return s; })
                .catch((e) => { this.lastSignInFailure = this.opts.now(); this.lastSignInError = e.message; throw e; })
                .finally(() => { this.signingIn = null; });
        }
        return this.signingIn;
    }

    private basic(userId: string, token: string): string { return 'Basic ' + Buffer.from(`${userId}:${token}`, 'utf8').toString('base64'); }
    private async send(url: string, init: any, what: string): Promise<Response> {
        try { return await this.opts.fetch(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs) }); }
        catch (err) { throw networkError(err, what); }
    }

    // As the web app signs in: POST /auth {provider:"tfp", token:null, user, pwd, device} with no Authorization header. The reply is the user
    // record, with userId at the top and authorizations[0].token; later calls send Basic base64(userId:token). The new token is checked
    // with GET /userprefs/refresh (which also gives the default pool), with a short wait if it is not accepted yet.
    private async signIn(): Promise<{ userId: string; token: string; poolId?: string }> {
        let creds: { u: string; pw: string };
        try { creds = await loadPoolMathCredentials(this.credentialsFile(), this.opts.machineId); }
        catch (err) { throw new PoolMathError(err.message, undefined, false, true); }
        const res = await this.send(POOLMATH_API + '/auth', {
            method: 'POST',
            headers: { 'User-Agent': this.opts.userAgent, 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'tfp', token: null, user: creds.u, pwd: creds.pw, device: this.opts.device })
        }, 'PoolMath sign-in');
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch (err) { /* not JSON */ }
        if (!res.ok || !json) throw new PoolMathError(`PoolMath sign-in failed (HTTP ${res.status}).`, res.status, false, true);
        const userId = typeof json.userId === 'string' ? json.userId : null;
        const auth = Array.isArray(json.authorizations) ? json.authorizations[0] : null;
        const token = auth && typeof auth.token === 'string' ? auth.token : null;
        if (!userId || !token) throw new PoolMathError(`PoolMath sign-in answered (HTTP ${res.status}) without a user id and token.`, res.status, false, true);
        let status = 0;
        for (const waitMs of this.opts.probeWaitsMs) {
            if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
            const probe = await this.send(POOLMATH_API + '/userprefs/refresh', {
                headers: { 'Authorization': this.basic(userId, token), 'User-Agent': this.opts.userAgent, 'Accept': 'application/json' }
            }, 'PoolMath sign-in check');
            const ptext = await probe.text();
            status = probe.status;
            if (probe.ok) {
                let prefs: any = null;
                try { prefs = JSON.parse(ptext); } catch (err) { /* not JSON */ }
                return { userId, token, poolId: prefs && typeof prefs.defPoolId === 'string' ? prefs.defPoolId : undefined };
            }
            if (status !== 401) break;
        }
        throw new PoolMathError(`Signed in to PoolMath, but the new token was not accepted (HTTP ${status}).`, status, false, true);
    }

    // The pool new entries go to: the account's default pool.
    public async poolId(): Promise<string> {
        const s = await this.ensureSession();
        if (s.poolId) return s.poolId;
        const prefs = await this.request('GET', 'userprefs/refresh');
        const id = prefs && typeof prefs.defPoolId === 'string' ? prefs.defPoolId : undefined;
        if (!id) throw new PoolMathError('The PoolMath account has no default pool.');
        if (this.session) this.session.poolId = id;
        return id;
    }

    public async request(method: string, route: string, body?: any): Promise<any> {
        for (let attempt = 1; ; attempt++) {
            const session = await this.ensureSession();
            const headers: { [k: string]: string } = { 'Authorization': this.basic(session.userId, session.token), 'User-Agent': this.opts.userAgent, 'Accept': 'application/json' };
            if (typeof body !== 'undefined') headers['Content-Type'] = 'application/json';
            const what = `${method} /${route.replace(/[0-9a-f-]{36}/gi, '<id>')}`;
            const res = await this.send(POOLMATH_API + '/' + route, { method, headers, body: typeof body === 'undefined' ? undefined : JSON.stringify(body) }, what);
            if (res.status === 401 && attempt === 1) {
                await res.text().catch(() => '');
                if (this.session === session) this.session = null;   // the token expired or was revoked: sign in again, once
                continue;
            }
            const text = await res.text();
            let json: any = null;
            try { json = text ? JSON.parse(text) : null; } catch (err) { /* not JSON */ }
            if (!res.ok) throw new PoolMathError(`${what} -> HTTP ${res.status}`, res.status);
            return json;
        }
    }
}

// The time as PoolMath's logTimestamp: UTC, no milliseconds.
export function poolMathTimestamp(ms: number): string { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

// An SWG chemlog as the web app writes it.
export function swgChemlog(opts: { poolId: string; userId: string; ts: number; percent: number; hours: number; ppm: number }) {
    return {
        type: 'chemlog', Chemical: CHEM_SWG, runTime: opts.hours, Percent: opts.percent,
        Unit: UNIT_PPM, Amount: opts.ppm, NormalizedAmount: opts.ppm,
        poolId: opts.poolId, logTimestamp: poolMathTimestamp(opts.ts),
        weather: null, weatherLogId: null, userId: opts.userId, origin: null, id: null,
        _ts: -62135596800, deleted: false
    };
}
