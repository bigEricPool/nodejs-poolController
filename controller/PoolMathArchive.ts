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
// has moved on: everything PoolMath sends for each log (every test value, every chemical and salt addition, SWG runs, the weather PoolMath
// attached, any text), from which, for example, the cell usage before the chlorinator output log began can be estimated (see
// ChlorinatorUsage.ts), and which any feature can read as history series (historyKindsOf / historySeriesOf). Entries are accumulated
// across syncs (an entry that has dropped out of what PoolMath returns stays archived until it ages past the retention period) and
// de-duplicated by PoolMath's log id; entries PoolMath reports as deleted are removed and edited ones replaced. The pool's details
// (volume, SWG rating, build type, targets, latest readings) are kept from the same response, without the share code or account id.
//
// Stored in data/poolMathArchive.json next to poolConfig.json. PoolMath's share endpoint is rate limited (about one request per minute),
// so a sync makes one request, waits out any 429 before retrying, and keeps a clock that any other reader of the share endpoint should
// share (see noteShareRequest).
//
// The full sync is a one-time pull per share code: it runs only when the archive isn't already for the configured share code and pool
// (the first time, after either changes, or once when the archive's format is older), not on a schedule -- see isPoolMathArchiveCurrent.
// Small top-ups keep it current between (see topUpPoolMathArchive and PoolMathSync.ts).

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

// One archived PoolMath log entry. Everything PoolMath sends for the log is kept, as it sends it (units included), so nothing has to be
// re-pulled to use it later: the common numbers as named fields, the weather PoolMath attached in full, and any other field in `extra`.
export interface PoolMathArchiveEntry {
    id: string;                 // PoolMath's log id
    type: string;               // 'testlog' | 'chemlog' | any other kind PoolMath reports
    ts: string;                 // ISO logTimestamp
    // testlog
    fc?: number; cc?: number; cya?: number; ph?: number; ta?: number; ch?: number; salt?: number; csi?: number; bor?: number;
    waterTemp?: number; waterTempUnits?: number;
    // chemlog, including SWG entries (see POOLMATH_CHEMICALS and POOLMATH_UNITS)
    chemical?: number; runTime?: number; percent?: number; unit?: number; amount?: number; normalizedAmount?: number;
    // Three of the weather numbers PoolMath attached to the entry, as named fields (sunlight drives most chlorine loss)
    uvIndex?: number; weatherTemp?: number; cloudCover?: number;
    // All of the weather PoolMath attached, as it sent it (metric: temp in °C, precipPast24Hours in mm, pressure in hPa, ...)
    weather?: { [key: string]: any };
    // Any other field the log carried (a note, a test PoolMath added later, ...), as it was sent
    extra?: { [key: string]: any };
}

export interface PoolMathArchive {
    shareCode?: string;         // what the entries were pulled for; a different pool starts fresh (see archiveIsForPool)
    poolName?: string;
    syncedAt?: string;          // ISO time of the last successful sync
    toppedUpAt?: string;        // ISO time of the last top-up that changed something (see topUpPoolMathArchive)
    format?: number;            // see POOLMATH_ARCHIVE_FORMAT
    pool?: PoolMathPoolInfo;   // what PoolMath said about the pool at the last sync or top-up
    details?: { [key: string]: any }; // all of PoolMath's pool details (build type, targets, tracked tests, latest readings), see poolDetailsOf
    entries: PoolMathArchiveEntry[];
}

// What PoolMath calls its chemicals, by its chemical id. Only ids checked against the share page's own wording are named; any other is
// shown as "Chemical <id>". normalizedAmount is in mL for a liquid, grams for a dry chemical, and ppm for an SWG run.
export const POOLMATH_CHEMICALS: { [id: number]: string } = { 0: 'Liquid Chlorine', 14: 'Muriatic Acid', 24: 'Dry Stabilizer', 26: 'Salt', 27: 'SWG' };
// PoolMath's amount units, by unit id (checked against the share page and normalizedAmount).
export const POOLMATH_UNITS: { [id: number]: string } = { 4: 'fl oz', 6: 'lb', 7: 'oz', 8: 'ppm' };
export function chemicalName(id: number): string { return typeof POOLMATH_CHEMICALS[id] === 'string' ? POOLMATH_CHEMICALS[id] : `Chemical ${id}`; }

// The pool's details from the share, as PoolMath sends them, without what identifies the PoolMath account or the share itself.
const PRIVATE_POOL_KEYS = ['shareCode', 'shareWithCode', 'userId', 'id'];
export function poolDetailsOf(pool: any): { [key: string]: any } {
    const p = (pool && pool.pool) || {};
    const out: { [key: string]: any } = {};
    for (const k of Object.keys(p)) if (PRIVATE_POOL_KEYS.indexOf(k) === -1 && p[k] !== null && typeof p[k] !== 'undefined') out[k] = p[k];
    return out;
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

// Whether the archived entries are the pool a full sync just read: the same share code and pool name, or else any log id PoolMath
// returned (including deleted ones) already in the archive. Log ids belong to one pool, so a renamed pool or a new share link for it
// keeps its history, and only a different pool starts fresh.
export function archiveIsForPool(archive: PoolMathArchive, shareCode: string, poolName: string | undefined, returnedIds: any[]): boolean {
    if (!archive || !Array.isArray(archive.entries) || !archive.entries.length) return true;
    if (archive.shareCode === shareCode && (archive.poolName || '') === (poolName || '')) return true;
    const have = new Set(archive.entries.map(e => e.id));
    return (returnedIds || []).some(id => typeof id === 'string' && have.has(id));
}

// Copies the archive aside before it is replaced by another pool's (data/poolMathArchive.json.<time>.bak); never overwrites a copy.
export function backUpPoolMathArchive(): string | undefined {
    const file = archivePath();
    try {
        if (!fs.existsSync(file)) return undefined;
        const bak = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL);
        logger.info(`PoolMath archive: the archived entries are another pool's; the old archive was copied to ${bak}.`);
        return bak;
    } catch (err) { logger.warn(`PoolMath archive: could not copy the old archive aside: ${err.message}`); return undefined; }
}

// The archive's format: an archive pulled before every field was kept (no `format`) is pulled again once, so its older entries get the fields
// that were left out then (the full weather, CSI, borates, chemicals the old top-up skipped).
export const POOLMATH_ARCHIVE_FORMAT = 2;
function isArchiveCurrent(a: PoolMathArchive, shareCode: string, poolName?: string): boolean {
    return !!a.syncedAt && a.shareCode === shareCode && (a.poolName || '') === (poolName || '') && (a.format || 0) >= POOLMATH_ARCHIVE_FORMAT;
}
// True when the archive was pulled for this share code and pool, in the current format, so no full sync is needed.
export function isPoolMathArchiveCurrent(shareCode: string, poolName?: string): boolean {
    return isArchiveCurrent(readPoolMathArchive(), shareCode, poolName);
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
// Stabilizer (CYA) added to the pool is chemical id 24: `unit` 7 (ounces) or 6 (pounds) and `normalizedAmount` in grams. Checked on the pool this was
// written for: 32 oz on 2026-02-21 and 2026-06-26 and 24 oz on 2026-08-15 were each followed by a CYA test 15 to 20 ppm higher, and 32 oz of cyanuric
// acid in 12,000 gallons is about 20 ppm.
export const POOLMATH_STABILIZER_CHEMICAL = 24;
export function isStabilizerEntry(e: PoolMathArchiveEntry): boolean {
    return e.type === 'chemlog' && e.chemical === POOLMATH_STABILIZER_CHEMICAL && typeof e.normalizedAmount === 'number' && e.normalizedAmount > 0;
}
// ppm of CYA that `grams` of stabilizer adds to a pool of `gallons` (milligrams per liter).
export function stabilizerPpm(grams: number, gallons: number): number {
    return gallons > 0 ? grams * 1000 / (gallons * 3.785411784) : 0;
}
// The archived stabilizer additions, oldest first: grams, and the ppm of CYA they add to `gallons` (0 when the volume is not known).
export function stabilizerAdditionsOf(entries: PoolMathArchiveEntry[], gallons?: number): { ts: Date; grams: number; ppm: number }[] {
    return entries
        .filter(isStabilizerEntry)
        .map(e => ({ ts: new Date(e.ts), grams: e.normalizedAmount, ppm: stabilizerPpm(e.normalizedAmount, gallons || 0) }))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}
export function archivedStabilizerAdditions(gallons?: number): { ts: Date; grams: number; ppm: number }[] {
    const a = readPoolMathArchive();
    return stabilizerAdditionsOf(a.entries, gallons || (a.pool && a.pool.gallons));
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

// What a top-up does to the archive, for the entries PoolMath returned (its newest logs): an entry it returned replaces the archived one with the
// same id (so an edit made in PoolMath shows up), an entry it marks deleted is removed whatever its kind, an entry the archive has not got is
// added, and an archived entry added from elsewhere under an id of its own is replaced by PoolMath's own entry for the same reading (see
// dropSupersededEntries). Archived entries older than what PoolMath returned are left as they are.
export interface PoolMathTopUpResult {
    fetched: number;            // entries PoolMath returned (not deleted)
    added: number;              // new to the archive
    updated: number;            // archived entries PoolMath now reports differently (an edit), or replaced by PoolMath's own entry
    removed: number;            // archived entries PoolMath reports deleted
    saltAdded: number; stabilizerAdded: number; testsAdded: number; // of `added`, by kind
    testsEnriched: number;      // of `updated`, the test logs
    pool?: PoolMathPoolInfo;
}
export function mergeTopUp(entries: PoolMathArchiveEntry[], fetched: PoolMathArchiveEntry[], deletedIds: Set<string>, cutoff: number): { entries: PoolMathArchiveEntry[] } & PoolMathTopUpResult {
    let removed = 0, added = 0, updated = 0, saltAdded = 0, stabilizerAdded = 0, testsAdded = 0, testsEnriched = 0;
    const current = fetched.filter(e => { const t = new Date(e.ts).getTime(); return !isNaN(t) && t >= cutoff && !deletedIds.has(e.id); });
    const kept = entries.filter(e => { if (deletedIds.has(e.id)) { removed++; return false; } return true; });
    const unsuperseded = dropSupersededEntries(kept, current);
    let replaced = kept.length - unsuperseded.length;
    const byId = new Map<string, PoolMathArchiveEntry>(unsuperseded.map(e => [e.id, e] as [string, PoolMathArchiveEntry]));
    for (const e of current) {
        const old = byId.get(e.id);
        byId.set(e.id, e);
        if (old) {
            if (JSON.stringify(old) !== JSON.stringify(e)) { updated++; if (e.type === 'testlog') testsEnriched++; }
        }
        else if (replaced > 0) { replaced--; updated++; if (e.type === 'testlog') testsEnriched++; }
        else {
            added++;
            if (isSaltEntry(e)) saltAdded++;
            else if (isStabilizerEntry(e)) stabilizerAdded++;
            else if (e.type === 'testlog') testsAdded++;
        }
    }
    const out = Array.from(byId.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    return { entries: out, fetched: current.length, added, updated, removed, saltAdded, stabilizerAdded, testsAdded, testsEnriched };
}

// The pool details without what changes on every request (PoolMath's calculatedAt), to tell whether they changed.
function detailsKey(details: { [key: string]: any } | undefined): string {
    if (!details) return '';
    const o = details.overview && typeof details.overview === 'object' ? { ...details.overview, calculatedAt: undefined } : details.overview;
    return JSON.stringify({ ...details, overview: o });
}

// How many of the newest logs a top-up asks for: a small read often (TOP_UP_SMALL reaches back about five weeks on a pool logged most days),
// and now and then a wider one so an edit to an older entry is picked up too.
export const TOP_UP_SMALL = 25;
export const TOP_UP_WIDE = RECENT_LOGS_SIZES[0];

// One request for the newest `size` entries, merged into the archive as above. Does nothing (returns undefined) until the full pull has been done
// for this share code and pool. The archive file is written only when something changed.
export async function topUpPoolMathArchive(shareCode: string, poolName?: string, size: number = TOP_UP_SMALL): Promise<PoolMathTopUpResult | undefined> {
    if (!shareCode) throw new Error('No PoolMath share code is configured.');
    const archive = readPoolMathArchive();
    if (!isArchiveCurrent(archive, shareCode, poolName)) return undefined;
    const got = await fetchRecentLogs(shareCode, size);
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
    const details = poolDetailsOf(pool);
    const infoChanged = JSON.stringify(info) !== JSON.stringify(archive.pool || {}) || detailsKey(details) !== detailsKey(archive.details);
    if (merged.added || merged.updated || merged.removed || infoChanged)
        writePoolMathArchive({ ...archive, entries: merged.entries, pool: info, details, toppedUpAt: new Date().toISOString() });
    const { entries, ...result } = merged;
    return { ...result, pool: info };
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

// ---------------------------------------------------------------------------------------------------------------------------------------
// The archive as history series, for display (GET /state/poolMath/history) or any other feature. Each kind of data is a series of points:
//   tests      'fc', 'ph', 'csi', ... (any number a test log carries)    { t, v }
//   additions  'swg' (v = SWG %), 'chem:<id>' (v = amount as entered)    { t, v, text }
//   weather    'weather:<field>' (PoolMath's weather at the entry)       { t, v }
//   other      'log:<type>' (a log kind other than tests and chemicals), 'notes' (text a log carried)   { t, text }
// ---------------------------------------------------------------------------------------------------------------------------------------
export type PoolMathHistoryGroup = 'test' | 'addition' | 'weather' | 'log';
export interface PoolMathHistoryKind { kind: string; name: string; unit: string; group: PoolMathHistoryGroup; count: number; first?: string; last?: string; }
export interface PoolMathHistoryPoint { t: number; v?: number; text?: string; }

const TEST_KINDS: { [field: string]: [string, string] } = {
    fc: ['FC', 'ppm'], cc: ['CC', 'ppm'], cya: ['CYA', 'ppm'], ph: ['pH', ''], ta: ['TA', 'ppm'], ch: ['CH', 'ppm'], salt: ['Salt', 'ppm'],
    csi: ['CSI', ''], bor: ['Borates', 'ppm'], waterTemp: ['Water Temp', ''],
};
// PoolMath's weather is metric; units are given only where the values make them certain.
const WEATHER_KINDS: { [field: string]: [string, string] } = {
    temp: ['Air Temp', '°C'], tempFeelsLike: ['Feels Like', '°C'], uvIndex: ['UV Index', ''], cloudCover: ['Cloud Cover', '%'],
    precipPast24Hours: ['Rain, Past 24 h', 'mm'], relHumidity: ['Humidity', '%'], pressure: ['Pressure', 'hPa'],
    windSpeed: ['Wind Speed', ''], windGustSpeed: ['Wind Gusts', ''], windDir: ['Wind Direction', '°'], visibility: ['Visibility', ''],
};
// waterTempUnits 0 is °F (checked against the share page); 1 is taken to be °C.
function waterTempUnit(units: number | undefined): string { return units === 1 ? '°C' : '°F'; }
function fmt(n: number): string { return String(Math.round(n * 100) / 100); }

// The points one archived entry contributes, by kind, with each kind's name, unit and group.
interface KindPoint { kind: string; name: string; unit: string; group: PoolMathHistoryGroup; point: PoolMathHistoryPoint; }
export function historyPointsOf(e: PoolMathArchiveEntry): KindPoint[] {
    const t = new Date(e.ts).getTime();
    if (isNaN(t)) return [];
    const out: KindPoint[] = [];
    if (e.type === 'testlog') {
        for (const f of Object.keys(TEST_KINDS)) {
            const v = (e as any)[f];
            if (typeof v !== 'number') continue;
            const [name, unit] = TEST_KINDS[f];
            out.push({ kind: f, name, unit: f === 'waterTemp' ? waterTempUnit(e.waterTempUnits) : unit, group: 'test', point: { t, v } });
        }
        // a test PoolMath added after this was written
        for (const f of Object.keys(e.extra || {})) {
            const v = e.extra[f];
            if (typeof v === 'number' && isFinite(v)) out.push({ kind: f, name: f, unit: '', group: 'test', point: { t, v } });
        }
    }
    else if (e.type === 'chemlog' && typeof e.chemical === 'number') {
        if (isSwgEntry(e))
            out.push({ kind: 'swg', name: 'SWG', unit: '%', group: 'addition', point: { t, v: e.percent, text: `${fmt(e.amount)} ppm FC, SWG ${fmt(e.runTime)} h @ ${fmt(e.percent)}%` } });
        else {
            const unit = typeof e.unit === 'number' ? (POOLMATH_UNITS[e.unit] || `unit ${e.unit}`) : '';
            const name = chemicalName(e.chemical);
            const amount = typeof e.amount === 'number' ? e.amount : undefined;
            const text = `${typeof amount === 'number' ? fmt(amount) + (unit ? ' ' + unit : '') + ' of ' : ''}${name}${typeof e.percent === 'number' && e.chemical === POOLMATH_LIQUID_CHLORINE ? ' ' + fmt(e.percent) + '%' : ''}`;
            out.push({ kind: `chem:${e.chemical}`, name, unit, group: 'addition', point: { t, v: amount, text } });
        }
    }
    else out.push({ kind: `log:${e.type}`, name: e.type, unit: '', group: 'log', point: { t, text: textOf(e.extra) || e.type } });
    // the weather at the entry (an entry archived before the full weather was kept has three of its numbers)
    const w = e.weather || { uvIndex: e.uvIndex, temp: e.weatherTemp, cloudCover: e.cloudCover };
    for (const f of Object.keys(w)) {
        const v = w[f];
        if (typeof v !== 'number' || !isFinite(v) || f === 'icon') continue;
        const [name, unit] = WEATHER_KINDS[f] || [f, ''];
        out.push({ kind: `weather:${f}`, name, unit, group: 'weather', point: { t, v } });
    }
    // text a test or chemical log carried (a note)
    if (e.type === 'testlog' || e.type === 'chemlog') {
        const text = textOf(e.extra);
        if (text) out.push({ kind: 'notes', name: 'Notes', unit: '', group: 'log', point: { t, text } });
    }
    return out;
}
function textOf(extra: { [key: string]: any } | undefined): string {
    if (!extra) return '';
    return Object.keys(extra).filter(k => typeof extra[k] === 'string' && extra[k].trim()).map(k => extra[k].trim()).join('; ');
}

// Every kind of data in `entries`, with how many points it has and its first and last time, tests first.
export function historyKindsOf(entries: PoolMathArchiveEntry[]): PoolMathHistoryKind[] {
    const kinds = new Map<string, PoolMathHistoryKind & { firstT: number; lastT: number }>();
    for (const e of entries) {
        for (const kp of historyPointsOf(e)) {
            let k = kinds.get(kp.kind);
            if (!k) { k = { kind: kp.kind, name: kp.name, unit: kp.unit, group: kp.group, count: 0, firstT: Infinity, lastT: -Infinity }; kinds.set(kp.kind, k); }
            k.count++;
            if (kp.point.t < k.firstT) k.firstT = kp.point.t;
            if (kp.point.t >= k.lastT) { k.lastT = kp.point.t; k.unit = kp.unit; }
        }
    }
    const order: PoolMathHistoryGroup[] = ['test', 'addition', 'weather', 'log'];
    const testOrder = Object.keys(TEST_KINDS);
    const rank = (k: PoolMathHistoryKind) => k.group === 'test' && testOrder.indexOf(k.kind) !== -1 ? testOrder.indexOf(k.kind) : 1000;
    return Array.from(kinds.values())
        .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || rank(a) - rank(b) || a.name.localeCompare(b.name))
        .map(k => ({ kind: k.kind, name: k.name, unit: k.unit, group: k.group, count: k.count, first: new Date(k.firstT).toISOString(), last: new Date(k.lastT).toISOString() }));
}

// The points of the given kinds between `from` and `to` (ms), oldest first. A kind with no points in that span is an empty list.
export function historySeriesOf(entries: PoolMathArchiveEntry[], kinds: string[], from: number, to: number): { [kind: string]: PoolMathHistoryPoint[] } {
    const want = new Set(kinds);
    const series: { [kind: string]: PoolMathHistoryPoint[] } = {};
    for (const k of kinds) series[k] = [];
    for (const e of entries) {
        for (const kp of historyPointsOf(e)) {
            if (!want.has(kp.kind) || kp.point.t < from || kp.point.t > to) continue;
            series[kp.kind].push(kp.point);
        }
    }
    for (const k of Object.keys(series)) series[k].sort((a, b) => a.t - b.t);
    return series;
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

// The log fields kept as named numbers; the log fields that are PoolMath's bookkeeping, not part of what was entered.
const NUMBER_FIELDS = ['fc', 'cc', 'cya', 'ph', 'ta', 'ch', 'salt', 'csi', 'bor', 'waterTemp', 'waterTempUnits',
    'chemical', 'runTime', 'percent', 'unit', 'amount', 'normalizedAmount'];
const BOOKKEEPING_FIELDS = ['id', 'type', 'logTimestamp', 'poolId', '_ts', 'deleted', 'weather', 'userId'];

export function toEntry(log: any): PoolMathArchiveEntry | undefined {
    if (!log || typeof log.id !== 'string' || typeof log.type !== 'string') return undefined;
    const t = new Date(log.logTimestamp).getTime();
    if (isNaN(t)) return undefined;
    const e: PoolMathArchiveEntry = { id: log.id, type: log.type, ts: new Date(t).toISOString() };
    for (const k of NUMBER_FIELDS) { const n = num(log[k]); if (typeof n !== 'undefined') (e as any)[k] = n; }
    const weather = log.weather && typeof log.weather === 'object' ? log.weather : undefined;
    if (weather) {
        const fields: [keyof PoolMathArchiveEntry, any][] = [['uvIndex', weather.uvIndex], ['weatherTemp', weather.temp], ['cloudCover', weather.cloudCover]];
        for (const [k, v] of fields) { const n = num(v); if (typeof n !== 'undefined') (e as any)[k] = n; }
        const w: { [key: string]: any } = {};
        for (const k of Object.keys(weather)) if (weather[k] !== null && typeof weather[k] !== 'undefined') w[k] = weather[k];
        if (Object.keys(w).length) e.weather = w;
    }
    // anything else the log carried (text included), unless it is one of the fields above
    const extra: { [key: string]: any } = {};
    for (const k of Object.keys(log)) {
        if (NUMBER_FIELDS.indexOf(k) !== -1 || BOOKKEEPING_FIELDS.indexOf(k) !== -1) continue;
        const v = log[k];
        if (v === null || typeof v === 'undefined' || v === '') continue;
        extra[k] = v;
    }
    if (Object.keys(extra).length) e.extra = extra;
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
    // Entries of another pool are not kept; a new share code or pool name for the same pool keeps them (see archiveIsForPool).
    if (!archiveIsForPool(archive, shareCode, poolName, logs.map(l => l && l.id))) {
        // never replaced without a copy: if the copy fails the archive is left as it is
        if (archive.entries.length && !backUpPoolMathArchive()) throw new Error('The old PoolMath archive could not be copied aside, so it was not replaced.');
        archive = { entries: [] };
    }
    const byId = new Map<string, PoolMathArchiveEntry>();
    for (const e of dropSupersededEntries(archive.entries, fetched)) if (!deletedIds.has(e.id) && new Date(e.ts).getTime() >= cutoff) byId.set(e.id, e);
    const before = byId.size;
    for (const e of fetched) byId.set(e.id, e);
    const entries = Array.from(byId.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    const info = poolInfoOf(pool);
    writePoolMathArchive({ shareCode: shareCode, poolName: poolName || '', syncedAt: now.toISOString(), format: POOLMATH_ARCHIVE_FORMAT, pool: info, details: poolDetailsOf(pool), entries: entries });
    return {
        fetched: fetched.length,
        added: Math.max(0, byId.size - before),
        total: entries.length,
        oldest: entries.length ? entries[0].ts : undefined,
        requested: requested,
        pool: info,
    };
}
