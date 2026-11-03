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
// pull when the archive is not for that share code and pool (retried until it succeeds), then a small top-up about once a day. Nothing
// runs without a share code. The pool's volume and SWG rating PoolMath reports are copied into the poolMath section, and the archived
// SWG entries are offered to the cell usage count (ChlorinatorLogService.ts) for the time before the output log began.

import { logger } from '../logger/Logger';
import { sys } from './Equipment';
import { archivedSwgEvents, isPoolMathArchiveCurrent, poolMathArchiveSummary, PoolMathPoolInfo, PoolMathTopUpResult, readPoolMathArchive, syncPoolMathArchive, topUpPoolMathArchive } from './PoolMathArchive';
import { recountCellUsage, setPoolLogSwgEntriesSource } from './ChlorinatorLogService';

const SYNC_FIRST_DELAY_MS = 3 * 60 * 1000;
const SYNC_RETRY_MS = 30 * 60 * 1000;
const TOPUP_FIRST_DELAY_MS = 15 * 60 * 1000;
const TOPUP_MS = 24 * 3600 * 1000;
const TOPUP_RETRY_MS = 6 * 3600 * 1000;
const TOPUP_NOT_READY_MS = 30 * 60 * 1000;

let syncTimer: NodeJS.Timeout | undefined;
let topUpTimer: NodeJS.Timeout | undefined;
let syncRunning = false;

export interface PoolMathSyncStatus { syncedAt?: string; toppedUpAt?: string; count: number; oldest?: string; error?: string; pool?: PoolMathPoolInfo; }
const status: PoolMathSyncStatus = { count: 0 };
export function poolMathSyncStatus(): PoolMathSyncStatus {
    const sum = poolMathArchiveSummary();
    const a = readPoolMathArchive();
    return { ...status, syncedAt: sum.syncedAt, toppedUpAt: a.toppedUpAt, count: sum.count, oldest: sum.oldest, pool: a.pool };
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
    if (syncRunning) return;
    const cfg = sys.poolMath;
    if (!cfg.shareCode) return;
    syncRunning = true;
    let retryMs: number | undefined;
    try {
        const r = await syncPoolMathArchive(cfg.shareCode, cfg.poolName || undefined);
        status.error = undefined;
        applyPoolInfo(r.pool);
        logger.info(`PoolMath: history sync: ${r.fetched} entries returned (asked for ${r.requested}), ${r.added} new, ${r.total} archived back to ${r.oldest ? r.oldest.slice(0, 10) : 'n/a'}.`);
        notify('sync');
    }
    catch (err) {
        retryMs = SYNC_RETRY_MS;
        status.error = err.message;
        logger.warn(`PoolMath: history sync failed (${err.message}); trying again in ${retryMs / 60000} minutes.`);
    }
    finally {
        syncRunning = false;
        // after a failure, try again; after a success this does nothing unless the share code changed while the sync ran
        armPoolMathSync(typeof retryMs !== 'undefined' ? retryMs : 60 * 1000);
    }
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
        const cfg = sys.poolMath;
        if (cfg.shareCode) {
            if (syncRunning) next = TOPUP_NOT_READY_MS;
            else {
                const r = await topUpPoolMathArchive(cfg.shareCode, cfg.poolName || undefined);
                if (typeof r === 'undefined') next = TOPUP_NOT_READY_MS;   // the full pull has not happened yet
                else {
                    applyPoolInfo(r.pool);
                    if (r.saltAdded || r.testsEnriched || r.testsAdded || r.removed) logger.info(`PoolMath: archive top-up: ${r.saltAdded} salt addition${r.saltAdded === 1 ? '' : 's'}, ${r.testsEnriched} test${r.testsEnriched === 1 ? '' : 's'} filled in, ${r.testsAdded} test${r.testsAdded === 1 ? '' : 's'} added, ${r.removed} removed.`);
                    notify('topUp', r);
                }
            }
        }
    }
    catch (err) { next = TOPUP_RETRY_MS; status.error = err.message; logger.warn(`PoolMath: archive top-up failed (${err.message}); trying again in ${next / 3600000} hours.`); }
    finally { armPoolMathTopUp(next); }
}

// Sets the share code and pool name (PUT /config/poolMath); a change starts a new full pull.
export function setPoolMathSettings(obj: any) {
    if (!obj) return;
    const before = `${sys.poolMath.shareCode}|${sys.poolMath.poolName}`;
    if (typeof obj.shareCode !== 'undefined') {
        const code = obj.shareCode === null ? '' : String(obj.shareCode).trim();
        if (code.length > 200) throw new RangeError('The PoolMath share code is too long.');
        sys.poolMath.shareCode = code;
    }
    if (typeof obj.poolName !== 'undefined') sys.poolMath.poolName = obj.poolName === null ? '' : String(obj.poolName).substring(0, 60);
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
