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

// Local archive of up to POOLMATH_ARCHIVE_MONTHS of a pool's PoolMath log history, pulled in the background from the share link's
// JSON interface (https://api.poolmathapp.com/share/<code>.json?recentLogs=N). It keeps the history after PoolMath's own recent window
// has moved on: test readings, chemical additions and SWG entries, from which the cell usage before the chlorinator output log began
// can be estimated (see ChlorinatorUsage.ts). Entries are accumulated across syncs (an entry that has dropped out of what PoolMath
// returns stays archived until it ages past the retention period) and de-duplicated by PoolMath's log id; entries PoolMath reports as
// deleted are removed. The pool's volume and SWG rating are kept from the same response.
//
// Stored in data/poolMathArchive.json next to poolConfig.json. PoolMath's share endpoint is rate limited (about one request per minute),
// so a sync makes one request, waits out any 429 before retrying, and keeps a clock that any other reader of the share endpoint should
// share (see noteShareRequest).
//
// The full sync is a one-time pull per share code: it runs only when the archive isn't already for the configured share code and pool
// (the first time, or after either changes), not on a schedule -- see isPoolMathArchiveCurrent. A small top-up runs about once a day.

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { logger } from '../logger/Logger';

export const POOLMATH_ARCHIVE_MONTHS = 48;

// The time of the last request to PoolMath's share endpoint, from this module or any other reader of it (call noteShareRequest before
// each request), so the requests stay outside PoolMath's rate limit.
let lastShareRequestAt = 0;
export function noteShareRequest() { lastShareRequestAt = Date.now(); }
export function msSinceLastShareRequest(): number { return Date.now() - lastShareRequestAt; }

// How many log entries to ask for, smallest first: it stops at the first size that reaches back far
// enough (see syncPoolMathArchive), so a small account is one small request.
const RECENT_LOGS_SIZES = [500, 2000, 5000, 10000];
// PoolMath allows roughly one share request per minute; stay comfortably outside that.
const MIN_GAP_MS = 90 * 1000;
const RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 70 * 1000;
const MAX_WAIT_MS = 5 * 60 * 1000;

// One archived PoolMath log entry. Numeric fields are kept as PoolMath reports them (units
// included) rather than interpreted, so nothing has to be re-pulled to use them later.
export interface PoolMathArchiveEntry {
    id: string;                 // PoolMath's log id
    type: string;               // 'testlog' | 'chemlog' | any other kind PoolMath reports
    ts: string;                 // ISO logTimestamp
    // testlog
    fc?: number; cc?: number; cya?: number; ph?: number; ta?: number; ch?: number; salt?: number; waterTemp?: number; waterTempUnits?: number;
    // chemlog, including SWG entries (which chemical id / unit PoolMath uses for them is
    // deliberately not assumed here)
    chemical?: number; runTime?: number; percent?: number; unit?: number; amount?: number; normalizedAmount?: number;
    // Weather PoolMath attached to the entry -- sunlight drives most chlorine loss
    uvIndex?: number; weatherTemp?: number; cloudCover?: number;
}

export interface PoolMathArchive {
    shareCode?: string;         // what the entries were pulled for; a change discards them
    poolName?: string;
    syncedAt?: string;          // ISO time of the last successful sync
    toppedUpAt?: string;        // ISO time of the last top-up (see topUpPoolMathArchive)
    pool?: PoolMathPoolInfo;    // what PoolMath said about the pool at the last sync or top-up
    entries: PoolMathArchiveEntry[];
}

// The pool's details from the share: its volume in gallons (only when PoolMath reports gallons) and its SWG rating in lb/day.
export interface PoolMathPoolInfo { name?: string; gallons?: number; swgLbsPerDay?: number; swgModelId?: string; }
export function poolInfoOf(pool: any): PoolMathPoolInfo {
    const p = (pool && pool.pool) || {};
    const info: PoolMathPoolInfo = {};
    if (typeof p.name === 'string') info.name = p.name;
    // poolVolumeUnit 0 is gallons; another unit is not converted here (not verified), so the volume is left out
    if (typeof p.volume === 'number' && p.volume > 0 && (typeof p.poolVolumeUnit === 'undefined' || p.poolVolumeUnit === 0)) info.gallons = p.volume;
    if (typeof p.swgLbsPerDay === 'number' && p.swgLbsPerDay > 0) info.swgLbsPerDay = p.swgLbsPerDay;
    if (typeof p.swgModelId === 'string' && p.swgModelId) info.swgModelId = p.swgModelId;
    return info;
}

export interface PoolMathSyncResult {
    fetched: number;            // entries PoolMath returned (not deleted, within retention)
    added: number;              // new to the archive
    total: number;              // archive size afterwards
    oldest?: string;            // ISO timestamp of the oldest archived entry
    requested: number;          // the recentLogs size that was accepted
    pool: PoolMathPoolInfo;
}

function archivePath(): string { return path.join(process.cwd(), 'data', 'poolMathArchive.json'); }

export function readPoolMathArchive(): PoolMathArchive {
    try {
        const parsed = JSON.parse(fs.readFileSync(archivePath(), 'utf8'));
        if (parsed && Array.isArray(parsed.entries)) return parsed;
    }
    catch (err) {
        if (err && err.code !== 'ENOENT') logger.warn(`PoolMath archive: could not read ${archivePath()}: ${err.message}`);
    }
    return { entries: [] };
}

export function writePoolMathArchive(archive: PoolMathArchive) {
    const file = archivePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(archive), 'utf8');
    fs.renameSync(tmp, file);
}

export function retentionCutoff(now: Date): number {
    const cutoff = new Date(now.getTime());
    cutoff.setMonth(cutoff.getMonth() - POOLMATH_ARCHIVE_MONTHS);
    return cutoff.getTime();
}

// True when the archive was pulled for this share code and pool, so no sync is needed.
export function isPoolMathArchiveCurrent(shareCode: string, poolName?: string): boolean {
    const a = readPoolMathArchive();
    return !!a.syncedAt && a.shareCode === shareCode && (a.poolName || '') === (poolName || '');
}

// Summary of what's archived.
export function poolMathArchiveSummary(): { syncedAt?: string; count: number; oldest?: string } {
    const a = readPoolMathArchive();
    return { syncedAt: a.syncedAt, count: a.entries.length, oldest: a.entries.length ? a.entries[0].ts : undefined };
}

// PoolMath logs an SWG run as a chemical entry: chemical id 27, with `runTime` (hours),
// `percent` (SWG %) and `amount` (the ppm FC it was credited with) -- the same three numbers
// the share page shows as "X ppm FC ... SWG Y hrs @ Z%". Identified by that id ONLY: other chemical
// entries (acid, salt, ...) can carry a stray run time and percent -- they are not SWG runs.
export const POOLMATH_SWG_CHEMICAL = 27;
export function isSwgEntry(e: PoolMathArchiveEntry): boolean {
    return e.type === 'chemlog' && e.chemical === POOLMATH_SWG_CHEMICAL
        && typeof e.amount === 'number' && typeof e.runTime === 'number' && typeof e.percent === 'number';
}

// Liquid chlorine is PoolMath chemical id 0: `percent` strength and `normalizedAmount` in mL.
export const POOLMATH_LIQUID_CHLORINE = 0;

// Salt added to the pool is chemical id 26: `unit` 6 (pounds) and `normalizedAmount` in grams. On the pool this was checked on, each 40 lb entry
// was followed by a rise of 400 to 600 ppm in the salt tests, and 40 lb of salt in 12,000 gallons is about 400 ppm. The share page's HTML is not
// read for these (what a salt card says there has not been checked); the JSON feed is, by topUpPoolMathArchive.
const POOLMATH_SALT_CHEMICAL = 26;
const GRAMS_PER_POUND = 453.59237;
function isSaltEntry(e: PoolMathArchiveEntry): boolean {
    return e.type === 'chemlog' && e.chemical === POOLMATH_SALT_CHEMICAL && typeof e.normalizedAmount === 'number' && e.normalizedAmount > 0;
}

// The archived salt additions in pounds, oldest first.
export function archivedSaltAdditions(): { ts: Date; pounds: number }[] {
    return readPoolMathArchive().entries
        .filter(isSaltEntry)
        .map(e => ({ ts: new Date(e.ts), pounds: e.normalizedAmount / GRAMS_PER_POUND }))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

// ppm of salt that `pounds` adds to a pool of `gallons` (milligrams per liter).
export function saltAdditionPpm(pounds: number, gallons: number): number {
    return gallons > 0 ? pounds * GRAMS_PER_POUND * 1000 / (gallons * 3.785411784) : 0;
}
export function isChlorineEntry(e: PoolMathArchiveEntry): boolean {
    return e.type === 'chemlog' && e.chemical === POOLMATH_LIQUID_CHLORINE && typeof e.percent === 'number' && typeof e.normalizedAmount === 'number';
}

// The archived entries a full sync keeps before adding what PoolMath returned: an entry whose id PoolMath did not return is dropped
// when PoolMath returned an entry of the same kind (test log, or the same chemical) within two minutes of it. That entry was added
// from elsewhere under an id of its own, and PoolMath's own entry for the same reading replaces it instead of standing beside it.
const SUPERSEDE_MS = 2 * 60 * 1000;
export function dropSupersededEntries(archived: PoolMathArchiveEntry[], fetched: PoolMathArchiveEntry[]): PoolMathArchiveEntry[] {
    const kindOf = (e: PoolMathArchiveEntry) => e.type === 'chemlog' ? `chemlog:${e.chemical}` : e.type;
    const fetchedIds = new Set(fetched.map(e => e.id));
    const timesByKind = new Map<string, number[]>();
    for (const e of fetched) {
        const t = new Date(e.ts).getTime();
        if (isNaN(t)) continue;
        const k = kindOf(e);
        if (!timesByKind.has(k)) timesByKind.set(k, []);
        timesByKind.get(k).push(t);
    }
    return archived.filter(e => {
        if (fetchedIds.has(e.id)) return true;
        const t = new Date(e.ts).getTime();
        const times = timesByKind.get(kindOf(e));
        return isNaN(t) || !times || !times.some(ft => Math.abs(ft - t) <= SUPERSEDE_MS);
    });
}

// What a top-up adds to the archive: salt additions it has not got, the extra numbers a new test carried (pH, TA, CH, salt, water
// temperature, weather), and tests it does not have at all. FC, CC, CYA, SWG runs and liquid chlorine already archived are left as
// they are (another reader of the share page may keep those current). Matching is by time, within two minutes, never by id, because
// entries added from elsewhere can have ids of their own.
export interface PoolMathTopUpResult { fetched: number; saltAdded: number; testsEnriched: number; testsAdded: number; removed: number; pool?: PoolMathPoolInfo; }
const TOP_UP_FIELDS: (keyof PoolMathArchiveEntry)[] = ['ph', 'ta', 'ch', 'salt', 'waterTemp', 'waterTempUnits', 'uvIndex', 'weatherTemp', 'cloudCover'];
export function mergeTopUp(entries: PoolMathArchiveEntry[], fetched: PoolMathArchiveEntry[], deletedIds: Set<string>, cutoff: number): { entries: PoolMathArchiveEntry[] } & PoolMathTopUpResult {
    const MATCH_MS = 2 * 60 * 1000;
    let saltAdded = 0, testsEnriched = 0, testsAdded = 0, removed = 0;
    const out = entries.filter(e => { if (deletedIds.has(e.id) && isSaltEntry(e)) { removed++; return false; } return true; });
    const have = new Set(out.map(e => e.id));
    for (const e of fetched) {
        const t = new Date(e.ts).getTime();
        if (isNaN(t) || t < cutoff) continue;
        if (isSaltEntry(e)) {
            if (!have.has(e.id)) { out.push(e); have.add(e.id); saltAdded++; }
            continue;
        }
        if (e.type !== 'testlog') continue;
        let match: PoolMathArchiveEntry | undefined;
        let bestGap = Infinity;
        for (const c of out) {
            if (c.type !== 'testlog') continue;
            const gap = Math.abs(new Date(c.ts).getTime() - t);
            if (gap <= MATCH_MS && gap < bestGap) { match = c; bestGap = gap; }
        }
        if (match) {
            let changed = false;
            for (const k of TOP_UP_FIELDS) if (typeof (match as any)[k] !== 'number' && typeof (e as any)[k] === 'number') { (match as any)[k] = (e as any)[k]; changed = true; }
            if (changed) testsEnriched++;
        }
        else if (!have.has(e.id) && (['fc', 'cc', 'cya', ...TOP_UP_FIELDS] as (keyof PoolMathArchiveEntry)[]).some(k => typeof (e as any)[k] === 'number')) {
            out.push(e); have.add(e.id); testsAdded++;
        }
    }
    out.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    return { entries: out, fetched: fetched.length, saltAdded, testsEnriched, testsAdded, removed };
}

// One request for the newest entries, merged into the archive as above. Does nothing (returns undefined) until the full pull has been done for this
// share code and pool. PoolMath's share endpoint is rate limited, so this is meant to run about once a day.
export async function topUpPoolMathArchive(shareCode: string, poolName?: string): Promise<PoolMathTopUpResult | undefined> {
    if (!shareCode) throw new Error('No PoolMath share code is configured.');
    const archive = readPoolMathArchive();
    if (!archive.syncedAt || archive.shareCode !== shareCode || (archive.poolName || '') !== (poolName || '')) return undefined;
    const got = await fetchRecentLogs(shareCode, RECENT_LOGS_SIZES[0]);
    if (typeof got === 'undefined') throw new Error('PoolMath did not accept the JSON history request.');
    const pool = pickPool(got, poolName);
    const logs: any[] = Array.isArray(pool.recentLogs) ? pool.recentLogs : [];
    const deletedIds = new Set<string>();
    const fetched: PoolMathArchiveEntry[] = [];
    for (const log of logs) {
        if (log && log.deleted === true) { if (typeof log.id === 'string') deletedIds.add(log.id); continue; }
        const e = toEntry(log);
        if (e) fetched.push(e);
    }
    const merged = mergeTopUp(archive.entries, fetched, deletedIds, retentionCutoff(new Date()));
    const info = poolInfoOf(pool);
    const infoChanged = JSON.stringify(info) !== JSON.stringify(archive.pool || {});
    if (merged.saltAdded || merged.testsEnriched || merged.testsAdded || merged.removed || infoChanged)
        writePoolMathArchive({ ...archive, entries: merged.entries, pool: info, toppedUpAt: new Date().toISOString() });
    return { fetched: merged.fetched, saltAdded: merged.saltAdded, testsEnriched: merged.testsEnriched, testsAdded: merged.testsAdded, removed: merged.removed, pool: info };
}

// The archived liquid chlorine additions, oldest first.
export function archivedChlorineAdditions(): { ts: Date; percent: number; ml: number }[] {
    return readPoolMathArchive().entries
        .filter(isChlorineEntry)
        .map(e => ({ ts: new Date(e.ts), percent: e.percent, ml: e.normalizedAmount }))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

// The archived SWG runs, oldest first, shaped like a share-page SWG entry.
export function archivedSwgEvents(): { ts: Date; ppmPerDay: number; hrs: number; pct: number }[] {
    return readPoolMathArchive().entries
        .filter(isSwgEntry)
        .map(e => ({ ts: new Date(e.ts), ppmPerDay: e.amount, hrs: e.runTime, pct: e.percent }))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

// The archived CYA (stabilizer) readings, oldest first.
export function archivedCyaReadings(): { ts: Date; value: number }[] {
    return readPoolMathArchive().entries
        .filter(e => e.type === 'testlog' && typeof e.cya === 'number')
        .map(e => ({ ts: new Date(e.ts), value: e.cya }))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

// The archived water temperatures logged with a test (in the units PoolMath logged them in), oldest first.
export function archivedWaterTemps(): { ts: Date; value: number }[] {
    return readPoolMathArchive().entries
        .filter(e => e.type === 'testlog' && typeof e.waterTemp === 'number')
        .map(e => ({ ts: new Date(e.ts), value: e.waterTemp }))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

// The archived FC test readings, oldest first, for merging into the combined history view.
export function archivedFcReadings(): { ts: Date; value: number }[] {
    return readPoolMathArchive().entries
        .filter(e => e.type === 'testlog' && typeof e.fc === 'number')
        .map(e => ({ ts: new Date(e.ts), value: e.fc }))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function httpGet(url: string, redirects = 3): Promise<{ status: number; headers: any; body: string }> {
    return new Promise((resolve, reject) => {
        try {
            const req = https.request(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (nodejs-poolController)' }, timeout: 60000 }, res => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                    res.resume();
                    httpGet(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject);
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', d => { body += d; });
                res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
            });
            req.on('timeout', () => req.destroy(new Error('PoolMath request timed out')));
            req.on('error', reject);
            req.end();
        } catch (err) { reject(err); }
    });
}

// The share link as a JSON URL with the requested number of recent logs.
function jsonUrl(shareCodeOrUrl: string, recentLogs: number): string {
    let base = shareCodeOrUrl.startsWith('http') ? shareCodeOrUrl : `https://api.poolmathapp.com/share/${shareCodeOrUrl}`;
    base = base.split('?')[0];
    if (!base.endsWith('.json')) base += '.json';
    return `${base}?recentLogs=${recentLogs}`;
}

function num(v: any): number | undefined { return typeof v === 'number' && isFinite(v) ? v : undefined; }

function pickPool(data: any, poolName?: string): any {
    const pools: any[] = Array.isArray(data && data.pools) ? data.pools : [];
    if (pools.length === 0) throw new Error('The PoolMath JSON has no pools.');
    if (!poolName) return pools[0];
    const want = poolName.trim().toLowerCase();
    const name = (p: any) => String(p && p.pool && p.pool.name || '').trim().toLowerCase();
    const match = pools.find(p => name(p) === want) || pools.find(p => name(p).includes(want));
    if (!match) throw new Error(`Pool '${poolName}' was not found in the PoolMath JSON.`);
    return match;
}

function toEntry(log: any): PoolMathArchiveEntry | undefined {
    if (!log || typeof log.id !== 'string' || typeof log.type !== 'string') return undefined;
    const t = new Date(log.logTimestamp).getTime();
    if (isNaN(t)) return undefined;
    const e: PoolMathArchiveEntry = { id: log.id, type: log.type, ts: new Date(t).toISOString() };
    const weather = log.weather || {};
    const fields: [keyof PoolMathArchiveEntry, any][] = [
        ['fc', log.fc], ['cc', log.cc], ['cya', log.cya], ['ph', log.ph], ['ta', log.ta], ['ch', log.ch], ['salt', log.salt],
        ['waterTemp', log.waterTemp], ['waterTempUnits', log.waterTempUnits],
        ['chemical', log.chemical], ['runTime', log.runTime], ['percent', log.percent], ['unit', log.unit],
        ['amount', log.amount], ['normalizedAmount', log.normalizedAmount],
        ['uvIndex', weather.uvIndex], ['weatherTemp', weather.temp], ['cloudCover', weather.cloudCover],
    ];
    for (const [k, v] of fields) { const n = num(v); if (typeof n !== 'undefined') (e as any)[k] = n; }
    return e;
}

// One request for the `size` most recent logs, waiting out any rate limiting first. Resolves to
// the parsed JSON, or to `undefined` when PoolMath rejects that size (HTTP 400/413/422); throws
// for anything else (rate limiting that outlasts the retries, another HTTP error, bad JSON).
async function fetchRecentLogs(shareCode: string, size: number): Promise<any | undefined> {
    for (let attempt = 0; ; attempt++) {
        // Leave a gap since ANY recent request to the share endpoint (the HTML fetch counts).
        const gap = MIN_GAP_MS - msSinceLastShareRequest();
        if (gap > 0) await sleep(gap);
        noteShareRequest();
        const res = await httpGet(jsonUrl(shareCode, size));
        if (res.status === 429) {
            if (attempt >= RATE_LIMIT_RETRIES) throw new Error('PoolMath is rate limiting the JSON request (HTTP 429).');
            const ra = parseInt(String(res.headers['retry-after'] || ''), 10);
            const wait = Math.min(MAX_WAIT_MS, isNaN(ra) ? DEFAULT_RETRY_AFTER_MS : Math.max(ra * 1000, 1000) + 5000);
            logger.info(`PoolMath archive: PoolMath rate limited the history sync; retrying in ${Math.round(wait / 1000)}s.`);
            await sleep(wait);
            continue;
        }
        if (res.status === 400 || res.status === 413 || res.status === 422) return undefined;
        if (res.status < 200 || res.status >= 300) throw new Error(`PoolMath returned HTTP ${res.status} for the JSON history.`);
        try { return JSON.parse(res.body); }
        catch (err) { throw new Error(`PoolMath's JSON response could not be parsed: ${err.message}`); }
    }
}

// One background sync: asks PoolMath's JSON interface for recent logs until they reach back
// POOLMATH_ARCHIVE_MONTHS (recentLogs is a count, not a date range, so it asks for a growing
// number and stops as soon as the oldest entry returned is past the cutoff, or PoolMath has
// returned everything it has), merges them into the archive, and writes it. Throws if nothing
// could be fetched, leaving the archive untouched; if a larger request fails after a smaller one
// succeeded, the smaller result is used.
export async function syncPoolMathArchive(shareCode: string, poolName?: string): Promise<PoolMathSyncResult> {
    if (!shareCode) throw new Error('No PoolMath share code is configured.');
    const cutoff = retentionCutoff(new Date());
    let data: any;
    let requested = 0;
    let lastError: Error | undefined;
    for (const size of RECENT_LOGS_SIZES) {
        let got: any;
        try { got = await fetchRecentLogs(shareCode, size); }
        catch (err) { lastError = err; break; }
        if (typeof got === 'undefined') break; // that size isn't accepted -- keep what we have
        data = got;
        requested = size;
        const logs: any[] = Array.isArray(pickPool(got, poolName).recentLogs) ? pickPool(got, poolName).recentLogs : [];
        const oldest = logs.reduce((m, l) => { const t = new Date(l && l.logTimestamp).getTime(); return isNaN(t) ? m : Math.min(m, t); }, Infinity);
        if (logs.length < size || oldest <= cutoff) break; // everything PoolMath has, or far enough back
    }
    if (!data) throw lastError || new Error('PoolMath did not accept any recentLogs size for the JSON history.');
    if (lastError) logger.warn(`PoolMath archive: PoolMath history sync stopped early (${lastError.message}); archiving what was fetched.`);

    const pool = pickPool(data, poolName);
    const logs: any[] = Array.isArray(pool.recentLogs) ? pool.recentLogs : [];
    const now = new Date();
    const deletedIds = new Set<string>();
    const fetched: PoolMathArchiveEntry[] = [];
    for (const log of logs) {
        if (log && log.deleted === true) { if (typeof log.id === 'string') deletedIds.add(log.id); continue; }
        const e = toEntry(log);
        if (e && new Date(e.ts).getTime() >= cutoff) fetched.push(e);
    }

    let archive = readPoolMathArchive();
    // A different share code or pool means the archived entries aren't this pool's.
    if (archive.shareCode !== shareCode || (archive.poolName || '') !== (poolName || '')) archive = { entries: [] };
    const byId = new Map<string, PoolMathArchiveEntry>();
    for (const e of dropSupersededEntries(archive.entries, fetched)) if (!deletedIds.has(e.id) && new Date(e.ts).getTime() >= cutoff) byId.set(e.id, e);
    const before = byId.size;
    for (const e of fetched) byId.set(e.id, e);
    const entries = Array.from(byId.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    const info = poolInfoOf(pool);
    writePoolMathArchive({ shareCode: shareCode, poolName: poolName || '', syncedAt: now.toISOString(), pool: info, entries: entries });
    return {
        fetched: fetched.length,
        added: Math.max(0, byId.size - before),
        total: entries.length,
        oldest: entries.length ? entries[0].ts : undefined,
        requested: requested,
        pool: info,
    };
}
