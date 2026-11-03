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

// Runs the chlorinator output log: samples every configured chlorinator every ten minutes (ChlorinatorLog.ts), credits each hour
// written to that chlorinator's cell usage totals (ChlorinatorUsage.ts), and recounts the totals from the install date when the
// cell's install date or rating changes.

import { logger } from '../logger/Logger';
import { ServiceParameterError } from './Errors';
import { sys } from './Equipment';
import { state } from './State';
import { chlorinatorLog, ChlorinatorOutputHour } from './ChlorinatorLog';
import { cellUsageForHour, cellUsageFromInstall, mergeSwgEntries, SwgEntry } from './ChlorinatorUsage';

const SAMPLE_MS = 10 * 60 * 1000;
let timer: NodeJS.Timeout | undefined;

// The SWG entries counted for the time before the output log began. Two sources, each set by another module (none by default): the
// pool's log (PoolMath, see PoolMathSync.ts), and entries this app wrote itself, which win over a pool log entry within an hour of them.
type SwgEntrySource = (chlorinatorId: number) => SwgEntry[];
let poolLogSwgEntries: SwgEntrySource | undefined;
let ownSwgEntries: SwgEntrySource | undefined;
export function setPoolLogSwgEntriesSource(fn: SwgEntrySource | undefined) { poolLogSwgEntries = fn; }
export function setOwnSwgEntriesSource(fn: SwgEntrySource | undefined) { ownSwgEntries = fn; }

// The chlorinator the log lines without an id belong to: the first configured chlorinator (lines were written for one only).
export function firstChlorinatorId(): number | undefined {
    const ids = sys.chlorinators.toArray().map(c => c.id).filter(id => typeof id === 'number').sort((a, b) => a - b);
    return ids.length ? ids[0] : undefined;
}

export function sampleChlorinators(now: number = Date.now()) {
    for (const chlor of sys.chlorinators.toArray()) {
        try {
            const s = state.chlorinators.getItemById(chlor.id, false);
            if (!s) continue;
            chlorinatorLog.record({
                id: chlor.id, output: s.currentOutput, set: s.poolSetpoint, target: s.targetOutput, status: s.status, salt: s.saltLevel,
                commAgeSec: typeof s.lastComm === 'number' && s.lastComm > 0 ? Math.max(0, Math.round((now - s.lastComm) / 1000)) : undefined
            }, now);
        }
        catch (err) { logger.warn(`Chlorinator log: could not sample chlorinator ${chlor.id}: ${err.message}`); }
    }
}

// Each hour written is added to that chlorinator's totals (hours that start before the totals were last set are already in them).
function creditHour(h: ChlorinatorOutputHour) {
    const first = firstChlorinatorId();
    const id = typeof h.id === 'number' ? h.id : first;
    if (typeof id !== 'number') return;
    const chlor = sys.chlorinators.find(c => c.id === id);
    if (!chlor) return;
    const s = state.chlorinators.getItemById(id, false);
    if (!s || new Date(h.t).getTime() < s.usageSince) return;
    const u = cellUsageForHour(h, chlor.cellLbsPerDay);
    if (u.hours > 0) { s.addUsage(u.hours, u.pounds, u.runHours); s.emitEquipmentChange(); }
}

function swgEntriesFor(id: number): SwgEntry[] {
    const own = ownSwgEntries ? (ownSwgEntries(id) || []) : [];
    const pool = poolLogSwgEntries ? (poolLogSwgEntries(id) || []) : [];
    return mergeSwgEntries(own, pool);
}

// Sets a chlorinator's totals to what the output log holds from the install date on, with an estimate from the SWG entries for the
// time before the log began. The pool volume for that estimate is PoolMath's, else the largest body's capacity.
export function recountCellUsage(id: number) {
    const chlor = sys.chlorinators.find(c => c.id === id);
    const s = state.chlorinators.getItemById(id, false);
    if (!chlor || !s || !chlor.cellInstalledDate) return undefined;
    const fromMs = new Date(chlor.cellInstalledDate + 'T00:00:00').getTime();
    if (!isFinite(fromMs)) return undefined;
    chlorinatorLog.flush();
    const hours = chlorinatorLog.read(548, Date.now(), id, firstChlorinatorId());
    const u = cellUsageFromInstall(hours, swgEntriesFor(id), fromMs, Date.now(), poolGallons(), chlor.cellLbsPerDay);
    const before = { hours: s.usageHours, pounds: s.usagePounds };
    s.resetUsage(u.hours, u.pounds, Date.now(), u.runHours, u.estimatedPounds);
    s.emitEquipmentChange();
    logger.info(`Chlorinator ${id}: cell usage counted from ${chlor.cellInstalledDate} at ${chlor.cellLbsPerDay} lb/day: ${u.hours.toFixed(1)} full-output hours, ` +
        `${u.runHours.toFixed(1)} h enabled, ${u.pounds.toFixed(2)} lb (was ${before.hours.toFixed(1)} h, ${before.pounds.toFixed(2)} lb), ` +
        `of which ${u.estimatedPounds.toFixed(2)} lb is estimated from SWG entries before the output log began${u.firstHour ? ` (${u.firstHour})` : ''}.`);
    return u;
}

export function poolGallons(): number {
    if (sys.poolMath.gallons > 0) return sys.poolMath.gallons;
    let cap = 0;
    for (const b of sys.bodies.toArray()) if (b.capacity > cap) cap = b.capacity;
    return cap;
}

// Checks the cell settings of a chlorinator save: the rating (lb/day, 0 or empty for the default) and the install date (YYYY-MM-DD, or
// empty). Throws on a bad value.
export function checkCellSettings(obj: any): { lbs?: number; date?: string } {
    let lbs: number | undefined;
    if (typeof obj.cellLbsPerDay !== 'undefined' && obj.cellLbsPerDay !== null && obj.cellLbsPerDay !== '') {
        lbs = Number(obj.cellLbsPerDay);
        if (!Number.isFinite(lbs) || lbs < 0 || lbs > 20) throw new ServiceParameterError('The cell rating must be a number of lb/day from 0 to 20.', 'setCellSettings', 'cellLbsPerDay', obj.cellLbsPerDay);
    }
    let date: string | undefined;
    if (typeof obj.cellInstalledDate !== 'undefined') {
        date = obj.cellInstalledDate === null ? '' : String(obj.cellInstalledDate).trim();
        if (date !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T00:00:00').getTime())))
            throw new ServiceParameterError('The cell install date must be YYYY-MM-DD.', 'setCellSettings', 'cellInstalledDate', obj.cellInstalledDate);
    }
    return { lbs, date };
}

// Applies the cell settings from a chlorinator save (PUT /config/chlorinator) and recounts the usage when the install date or the
// rating changed.
export function setCellSettings(id: number, obj: any) {
    if (!obj || (typeof obj.cellLbsPerDay === 'undefined' && typeof obj.cellInstalledDate === 'undefined')) return;
    const chlor = sys.chlorinators.find(c => c.id === id);
    if (!chlor) return;
    const { lbs, date } = checkCellSettings(obj);
    const prevLbs = chlor.cellLbsPerDay, prevDate = chlor.cellInstalledDate;
    if (typeof obj.cellLbsPerDay !== 'undefined') chlor.cellLbsPerDay = lbs;
    if (typeof date !== 'undefined') chlor.cellInstalledDate = date;
    if (chlor.cellInstalledDate && (chlor.cellLbsPerDay !== prevLbs || chlor.cellInstalledDate !== prevDate)) recountCellUsage(id);
}

export function cellUsageInfo(id: number) {
    const chlor = sys.chlorinators.find(c => c.id === id);
    const s = state.chlorinators.getItemById(id, false);
    if (!chlor || !s) return undefined;
    return {
        id: id,
        hours: Math.round(s.usageHours * 10) / 10, runHours: Math.round(s.usageRunHours * 10) / 10,
        pounds: Math.round(s.usagePounds * 100) / 100, estimatedPounds: Math.round(s.usageEstimatedPounds * 100) / 100,
        since: s.usageSince > 0 ? new Date(s.usageSince).toISOString() : '',
        installedDate: chlor.cellInstalledDate, lbsPerDay: chlor.cellLbsPerDay, lbsPerDaySetting: chlor.cellLbsPerDaySetting
    };
}

export function startChlorinatorLog() {
    if (timer) return;
    chlorinatorLog.onHour = creditHour;
    // a first sample a minute after start, when the chlorinators have reported, then every ten minutes
    timer = setTimeout(function tick() {
        try { sampleChlorinators(); } catch (err) { logger.warn(`Chlorinator log: ${err.message}`); }
        timer = setTimeout(tick, SAMPLE_MS);
    }, 60000);
}

export function stopChlorinatorLog() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    try { chlorinatorLog.flush(); } catch (err) { logger.warn(`Chlorinator log: could not write the last hour: ${err.message}`); }
}
