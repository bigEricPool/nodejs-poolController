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

// Keeps the PoolMath history archive (PoolMathArchive.ts) for the share code in the poolMath section of poolConfig.json: a one-time full
// pull when the archive is not for that share code and pool (retried until it succeeds), then a small top-up every TOPUP_MS (a wider one
// about once a day, so an edit to an older entry is picked up too). Nothing runs without a share code. Any feature can ask for a read now
// (requestPoolMathRefresh) and hear about new data (onPoolMathUpdated). The pool's volume and SWG rating PoolMath reports are copied into
// the poolMath section, and the archived SWG entries are offered to the cell usage count (ChlorinatorLogService.ts) for the time before the
// output log began. The archive keeps everything PoolMath sends; the poolMath section's historyKinds say which kinds are shown as history.

import { logger } from '../logger/Logger';
import { sys } from './Equipment';
import {
    archivedSwgEvents, historyKindsOf, historySeriesOf, isPoolMathArchiveCurrent, poolMathArchiveSummary, PoolMathHistoryKind, PoolMathHistoryPoint,
    PoolMathPoolInfo, PoolMathSyncResult, PoolMathTopUpResult, readPoolMathArchive, syncPoolMathArchive, topUpPoolMathArchive, TOP_UP_SMALL, TOP_UP_WIDE
} from './PoolMathArchive';
import { recountCellUsage, setPoolLogSwgEntriesSource } from './ChlorinatorLogService';

const SYNC_FIRST_DELAY_MS = 3 * 60 * 1000;
const SYNC_RETRY_MS = 30 * 60 * 1000;
const TOPUP_FIRST_DELAY_MS = 15 * 60 * 1000;
const TOPUP_MS = 45 * 60 * 1000;                // a small top-up this often
const TOPUP_WIDE_MS = 24 * 3600 * 1000;         // and a wide one this often (the first after a start is wide)
const TOPUP_RETRY_MS = 3 * 3600 * 1000;
const TOPUP_NOT_READY_MS = 30 * 60 * 1000;
// A request for a read now gets the last result instead when one ran this recently.
const REFRESH_MIN_MS = 2 * 60 * 1000;
const FULL_REFRESH_MIN_MS = 24 * 3600 * 1000;

let syncTimer: NodeJS.Timeout | undefined;
let topUpTimer: NodeJS.Timeout | undefined;
// The read running now (a sync or a top-up, scheduled or asked for); reads never overlap.
let running: Promise<PoolMathRefreshResult> | undefined;
let lastWideAt = 0;

export interface PoolMathRefreshResult {
    kind: 'sync' | 'topUp';
    ranAt: string;              // ISO time the read finished
    fresh: boolean;             // false when this is an earlier read's result (one ran within the minimum gap)
    sync?: PoolMathSyncResult;
    topUp?: PoolMathTopUpResult;
    error?: string;
}
let lastSync: PoolMathRefreshResult | undefined;
let lastTopUp: PoolMathRefreshResult | undefined;

export interface PoolMathSyncStatus {
    syncedAt?: string; toppedUpAt?: string; checkedAt?: string; count: number; oldest?: string; error?: string;
    pool?: PoolMathPoolInfo; details?: { [key: string]: any };
    historyKinds?: string[];    // the kinds shown as history, the defaults when none were chosen
}
const status: PoolMathSyncStatus = { count: 0 };
export function poolMathSyncStatus(): PoolMathSyncStatus {
    const sum = poolMathArchiveSummary();
    const a = readPoolMathArchive();
    const checked = [lastSync, lastTopUp].filter(r => r && !r.error).map(r => r.ranAt).sort().pop();
    return { ...status, syncedAt: sum.syncedAt, toppedUpAt: a.toppedUpAt, checkedAt: checked, count: sum.count, oldest: sum.oldest, pool: a.pool, details: a.details, historyKinds: selectedHistoryKinds() };
}

// Told after each successful sync or top-up (another module may want to look at new entries). Errors in a listener are logged.
const listeners: ((kind: 'sync' | 'topUp', result?: PoolMathTopUpResult) => void)[] = [];
export function onPoolMathUpdated(fn: (kind: 'sync' | 'topUp', result?: PoolMathTopUpResult) => void) { listeners.push(fn); }
function notify(kind: 'sync' | 'topUp', result?: PoolMathTopUpResult) {
    for (const fn of listeners) { try { fn(kind, result); } catch (err) { logger.warn(`PoolMath: a listener failed: ${err.message}`); } }
}

// Copies the pool's volume and SWG rating from PoolMath into the poolMath section. When that changes the rating a chlorinator counts at
// (it has no rating of its own), or the volume the estimate before the output log uses, its cell usage is counted again from its
// install date, so the totals are not a mix of the old and new values. Returns the ids recounted.
export function applyPoolInfo(info: PoolMathPoolInfo | undefined): number[] {
    if (!info) return [];
    const chlors = sys.chlorinators.toArray();
    const before = new Map<number, number>(chlors.map(c => [c.id, c.cellLbsPerDay] as [number, number]));
    let volumeChanged = false;
    if (info.gallons > 0 && sys.poolMath.gallons !== info.gallons) { sys.poolMath.gallons = info.gallons; volumeChanged = true; }
    if (info.swgLbsPerDay > 0 && sys.poolMath.swgLbsPerDay !== info.swgLbsPerDay) sys.poolMath.swgLbsPerDay = info.swgLbsPerDay;
    const recounted: number[] = [];
    for (const c of chlors) {
        if (!c.cellInstalledDate) continue;
        if (!volumeChanged && before.get(c.id) === c.cellLbsPerDay) continue;
        try { recountCellUsage(c.id); recounted.push(c.id); }
        catch (err) { logger.warn(`PoolMath: could not recount the cell usage of chlorinator ${c.id}: ${err.message}`); }
    }
    return recounted;
}

// Runs one read at a time: a read asked for while another runs gets that one's result.
function exclusive(fn: () => Promise<PoolMathRefreshResult>): Promise<PoolMathRefreshResult> {
    if (running) return running;
    running = fn().finally(() => { running = undefined; });
    return running;
}

function doSync(): Promise<PoolMathRefreshResult> {
    return exclusive(async () => {
        const cfg = sys.poolMath;
        try {
            const r = await syncPoolMathArchive(cfg.shareCode, cfg.poolName || undefined);
            status.error = undefined;
            applyPoolInfo(r.pool);
            lastWideAt = Date.now();
            logger.info(`PoolMath: history sync: ${r.fetched} entries returned (asked for ${r.requested}), ${r.added} new, ${r.total} archived back to ${r.oldest ? r.oldest.slice(0, 10) : 'n/a'}.`);
            lastSync = { kind: 'sync', ranAt: new Date().toISOString(), fresh: true, sync: r };
            notify('sync');
        }
        catch (err) {
            status.error = err.message;
            lastSync = { kind: 'sync', ranAt: new Date().toISOString(), fresh: true, error: err.message };
        }
        return lastSync;
    });
}

// A top-up; undefined result (no topUp, no error) when the full pull has not been done yet.
function doTopUp(size: number): Promise<PoolMathRefreshResult> {
    return exclusive(async () => {
        const cfg = sys.poolMath;
        const ranAt = () => new Date().toISOString();
        try {
            const r = await topUpPoolMathArchive(cfg.shareCode, cfg.poolName || undefined, size);
            if (typeof r === 'undefined') return { kind: 'topUp', ranAt: ranAt(), fresh: true } as PoolMathRefreshResult;
            status.error = undefined;
            if (size >= TOP_UP_WIDE) lastWideAt = Date.now();
            applyPoolInfo(r.pool);
            if (r.added || r.updated || r.removed) logger.info(`PoolMath: archive top-up: ${r.added} added, ${r.updated} updated, ${r.removed} removed.`);
            lastTopUp = { kind: 'topUp', ranAt: ranAt(), fresh: true, topUp: r };
            notify('topUp', r);
        }
        catch (err) {
            status.error = err.message;
            lastTopUp = { kind: 'topUp', ranAt: ranAt(), fresh: true, error: err.message };
        }
        return lastTopUp;
    });
}

// Asks for a read of PoolMath now: a top-up of the newest entries, or with `full` the whole history again (also when the full pull has not
// been done yet). Resolves when the read is done. Reads never overlap, and PoolMath's rate limit is kept: a read asked for while one runs
// gets that read's result, and one asked for within REFRESH_MIN_MS of the last top-up (FULL_REFRESH_MIN_MS of the last full pull) gets the
// last result back with `fresh: false`. Throws when no share code is set.
export async function requestPoolMathRefresh(opts: { full?: boolean } = {}): Promise<PoolMathRefreshResult> {
    const cfg = sys.poolMath;
    if (!cfg.shareCode) throw new Error('No PoolMath share code is configured.');
    if (running) return running;
    const full = opts.full === true || !isPoolMathArchiveCurrent(cfg.shareCode, cfg.poolName || undefined);
    const last = full ? lastSync : lastTopUp;
    if (last && !last.error && Date.now() - Date.parse(last.ranAt) < (full ? FULL_REFRESH_MIN_MS : REFRESH_MIN_MS)) return { ...last, fresh: false };
    const r = full ? await doSync() : await doTopUp(TOP_UP_SMALL);
    // a read now counts as the next scheduled one
    if (full) armPoolMathSync(typeof r.error === 'string' ? SYNC_RETRY_MS : 60 * 1000);
    armPoolMathTopUp(TOPUP_MS);
    return r;
}

export function armPoolMathSync(delayMs: number = SYNC_FIRST_DELAY_MS) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = undefined;
    const cfg = sys.poolMath;
    if (!cfg.shareCode) return;
    if (isPoolMathArchiveCurrent(cfg.shareCode, cfg.poolName || undefined)) { applyPoolInfo(readPoolMathArchive().pool); return; }
    syncTimer = setTimeout(() => { runSync().catch(err => logger.error(`PoolMath: history sync failed: ${err.message}`)); }, delayMs);
    syncTimer.unref();
}

async function runSync(): Promise<void> {
    syncTimer = undefined;
    if (!sys.poolMath.shareCode) return;
    const r = await doSync();
    if (r.error) logger.warn(`PoolMath: history sync failed (${r.error}); trying again in ${SYNC_RETRY_MS / 60000} minutes.`);
    // after a failure, try again; after a success this does nothing unless the share code changed while the sync ran
    armPoolMathSync(r.error ? SYNC_RETRY_MS : 60 * 1000);
}

export function armPoolMathTopUp(delayMs: number = TOPUP_FIRST_DELAY_MS) {
    if (topUpTimer) clearTimeout(topUpTimer);
    topUpTimer = setTimeout(() => { runTopUp().catch(err => logger.error(`PoolMath: archive top-up failed: ${err.message}`)); }, delayMs);
    topUpTimer.unref();
}

async function runTopUp(): Promise<void> {
    topUpTimer = undefined;
    let next = TOPUP_MS;
    try {
        if (sys.poolMath.shareCode) {
            const size = Date.now() - lastWideAt >= TOPUP_WIDE_MS ? TOP_UP_WIDE : TOP_UP_SMALL;
            const r = await doTopUp(size);
            if (r.error) { next = TOPUP_RETRY_MS; logger.warn(`PoolMath: archive top-up failed (${r.error}); trying again in ${next / 3600000} hours.`); }
            else if (!r.topUp) next = TOPUP_NOT_READY_MS;   // the full pull has not happened yet, or another read was running
        }
    }
    finally { armPoolMathTopUp(next); }
}

// The kinds of PoolMath data shown as history when none have been chosen: what njsPC kept from PoolMath before every field was archived.
export const DEFAULT_HISTORY_KINDS = ['fc', 'cc', 'cya', 'ph', 'ta', 'ch', 'salt', 'waterTemp', 'swg', 'chem:0', 'chem:26', 'chem:24',
    'weather:uvIndex', 'weather:temp', 'weather:cloudCover'];
export function selectedHistoryKinds(): string[] {
    const k = sys.poolMath.historyKinds;
    return Array.isArray(k) ? k : DEFAULT_HISTORY_KINDS.slice();
}

// Every kind of data in the archive, with whether it is chosen to be shown as history (GET /state/poolMath/history/kinds).
export function poolMathHistoryKinds(): (PoolMathHistoryKind & { selected: boolean })[] {
    const selected = new Set(selectedHistoryKinds());
    return historyKindsOf(readPoolMathArchive().entries).map(k => ({ ...k, selected: selected.has(k.kind) }));
}

// The history of the given kinds (the chosen ones when none are given) over the last `days` (all of the archive when not given)
// (GET /state/poolMath/history). Kinds the archive has no data for are left out.
export function poolMathHistory(kinds?: string[], days?: number): { from: number; to: number; series: { [kind: string]: PoolMathHistoryPoint[] } } {
    const entries = readPoolMathArchive().entries;
    const known = new Set(historyKindsOf(entries).map(k => k.kind));
    const want = (kinds && kinds.length ? kinds : selectedHistoryKinds()).filter(k => known.has(k));
    const to = Date.now();
    const oldest = entries.length ? new Date(entries[0].ts).getTime() : to;
    const from = typeof days === 'number' && days > 0 ? Math.max(to - days * 86400000, isNaN(oldest) ? 0 : oldest) : (isNaN(oldest) ? to : oldest);
    return { from, to, series: historySeriesOf(entries, want, from, to) };
}

// Sets the share code, pool name and the kinds shown as history (PUT /config/poolMath); a new share code or pool name starts a new full pull.
// historyKinds: a list of kind ids (see historyKindsOf), or null to go back to the defaults.
export function setPoolMathSettings(obj: any) {
    if (!obj) return;
    const before = `${sys.poolMath.shareCode}|${sys.poolMath.poolName}`;
    if (typeof obj.shareCode !== 'undefined') {
        const code = obj.shareCode === null ? '' : String(obj.shareCode).trim();
        if (code.length > 200) throw new RangeError('The PoolMath share code is too long.');
        sys.poolMath.shareCode = code;
    }
    if (typeof obj.poolName !== 'undefined') sys.poolMath.poolName = obj.poolName === null ? '' : String(obj.poolName).substring(0, 60);
    if (typeof obj.historyKinds !== 'undefined') {
        if (obj.historyKinds === null) sys.poolMath.historyKinds = undefined;
        else {
            if (!Array.isArray(obj.historyKinds) || obj.historyKinds.length > 200 || obj.historyKinds.some(k => typeof k !== 'string' || !k || k.length > 64))
                throw new RangeError('historyKinds must be a list of up to 200 kind ids.');
            sys.poolMath.historyKinds = Array.from(new Set<string>(obj.historyKinds));
        }
    }
    if (`${sys.poolMath.shareCode}|${sys.poolMath.poolName}` !== before) armPoolMathSync(5000);
}

export function startPoolMathSync() {
    // PoolMath's history is the pool's, so its SWG entries count for the cell only when there is one chlorinator.
    setPoolLogSwgEntriesSource(() => sys.chlorinators.length === 1 ? archivedSwgEvents().map(e => ({ ts: e.ts.getTime(), ppmPerDay: e.ppmPerDay, hrs: e.hrs, pct: e.pct })) : []);
    armPoolMathSync();
    armPoolMathTopUp();
}

export function stopPoolMathSync() {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = undefined; }
    if (topUpTimer) { clearTimeout(topUpTimer); topUpTimer = undefined; }
}
