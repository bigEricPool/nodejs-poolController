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
// cell's install date, rating or cycle settings change. Also writes when each chlorinator's power comes on and goes off
// (ChlorinatorPowerLog.ts), checked every 15 seconds, which places the cycles of a cell counted by cycles.

import { logger } from '../logger/Logger';
import { ServiceParameterError } from './Errors';
import { ControllerType } from './Constants';
import { Chlorinator, sys } from './Equipment';
import { state } from './State';
import { chlorinatorLog, ChlorinatorOutputHour, clockLooksSet } from './ChlorinatorLog';
import { chlorinatorPowerLog } from './ChlorinatorPowerLog';
import { cellUsageForHour, cellUsageFromInstall, CycleContext, mergeSwgEntries, pctAtFromHours, SwgEntry } from './ChlorinatorUsage';

const SAMPLE_MS = 10 * 60 * 1000;
const POWER_CHECK_MS = 15 * 1000;
let powerTimer: NodeJS.Timeout | undefined;

// Whether a chlorinator has power. The default is that its body is on; another module can say otherwise for its wiring (for example a
// relay that feeds the cell). The source returns undefined when it cannot tell, and the default is used.
export type ChlorinatorPowerSource = (chlor: Chlorinator) => boolean | undefined;
let powerSource: ChlorinatorPowerSource | undefined;
export function setChlorinatorPowerSource(fn: ChlorinatorPowerSource | undefined) { powerSource = fn; }
export function chlorinatorHasPower(chlor: Chlorinator): boolean | undefined {
    if (powerSource) {
        try { const v = powerSource(chlor); if (typeof v === 'boolean') return v; }
        catch (err) { logger.warn(`Chlorinator power log: the power source failed for chlorinator ${chlor.id}: ${err.message}`); }
    }
    try { return sys.board.bodies.isBodyOn(typeof chlor.body !== 'undefined' ? chlor.body : 0); }
    catch (err) { return undefined; }
}
// Writes each chlorinator's power state when it changed.
export function checkChlorinatorPower(now: number = Date.now()) {
    for (const chlor of sys.chlorinators.toArray()) {
        try {
            const on = chlorinatorHasPower(chlor);
            if (typeof on !== 'boolean') continue;
            const e = chlorinatorPowerLog.record(chlor.id, on, now);
            if (e) logger.verbose(`Chlorinator ${chlor.id}: power ${on ? 'on' : 'off'}.`);
        }
        catch (err) { logger.warn(`Chlorinator power log: could not check chlorinator ${chlor.id}: ${err.message}`); }
    }
}

// On Nixie njsPC drives the circuits itself (through its relay boards), so they go off while it is not running, and a cell powered by
// them starts a new cycle when it comes back. A controller with its own panel keeps its circuits running.
export function powerStopsWithApp(): boolean { return sys.controllerType === ControllerType.Nixie; }
// Writes "off" for each chlorinator last logged as powered, when its power stops with njsPC: at a stop, and at a start after a stop that
// wrote nothing (a crash or a power loss; the time is then the start, as the stop's time is not known). The next check writes "on".
export function markPowerOffWhileStopped(now: number = Date.now()) {
    if (!powerStopsWithApp()) return;
    for (const chlor of sys.chlorinators.toArray()) {
        try {
            const last = chlorinatorPowerLog.lastEvent(chlor.id);
            if (last && last.on) chlorinatorPowerLog.record(chlor.id, false, now);
        }
        catch (err) { logger.warn(`Chlorinator power log: could not mark chlorinator ${chlor.id} off: ${err.message}`); }
    }
}

// The cycle count's context for a chlorinator counted by cycles (undefined otherwise): its power events and the % in force, from the
// given logged hours of that chlorinator.
function cycleContextFor(chlor: Chlorinator, hours: ChlorinatorOutputHour[], now: number): CycleContext | undefined {
    if (!(chlor.cycleHours > 0)) return undefined;
    const events = chlorinatorPowerLog.read(1461, now, chlor.id).map(e => ({ t: new Date(e.t).getTime(), on: e.on }));
    if (!events.length) return undefined;
    return {
        cycle: { cycleHours: chlor.cycleHours, restartsOnPower: chlor.cycleRestartsOnPower, burstFirst: chlor.burstFirst },
        events: events, since: events[0].t, pctAt: pctAtFromHours(hours)
    };
}
// The last hours of each chlorinator, for the % in force at a cycle start when an hour is credited (a cycle can begin hours before).
const recentHours = new Map<number, ChlorinatorOutputHour[]>();
function recentHoursOf(id: number, h: ChlorinatorOutputHour): ChlorinatorOutputHour[] {
    let list = recentHours.get(id);
    if (!list) {
        list = chlorinatorLog.read(1, Date.now(), id, firstChlorinatorId());
        recentHours.set(id, list);
    }
    if (list.indexOf(h) < 0 && !list.some(x => x.t === h.t && x.n === h.n && x.id === h.id)) list.push(h);
    const keepFrom = new Date(h.t).getTime() - 12 * 3600000;
    while (list.length && new Date(list[0].t).getTime() < keepFrom) list.shift();
    return list;
}
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
    const ctx = chlor.cycleHours > 0 ? cycleContextFor(chlor, recentHoursOf(id, h), Date.now()) : undefined;
    const u = cellUsageForHour(h, chlor.cellLbsPerDay, ctx);
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
    const now = Date.now();
    // a clock that has not been set yet would count the wrong span; the totals are left as they are
    if (!clockLooksSet(now)) { logger.warn(`Chlorinator ${id}: cell usage not recounted, the time (${new Date(now).toISOString()}) looks unset.`); return undefined; }
    chlorinatorLog.flush();
    // every hour from the install date on (the log keeps up to CHLORINATOR_LOG_KEEP_MONTHS)
    const days = Math.max(1, Math.ceil((now - fromMs) / 86400000) + 1);
    const hours = chlorinatorLog.read(days, now, id, firstChlorinatorId());
    const u = cellUsageFromInstall(hours, swgEntriesFor(id), fromMs, now, poolGallons(), chlor.cellLbsPerDay, cycleContextFor(chlor, hours, now));
    const before = { hours: s.usageHours, pounds: s.usagePounds };
    s.resetUsage(u.hours, u.pounds, now, u.runHours, u.estimatedPounds);
    s.emitEquipmentChange();
    logger.info(`Chlorinator ${id}: cell usage counted from ${chlor.cellInstalledDate} at ${chlor.cellLbsPerDay} lb/day: ${u.hours.toFixed(1)} full-output hours, ` +
        `${u.runHours.toFixed(1)} h enabled, ${u.pounds.toFixed(2)} lb (was ${before.hours.toFixed(1)} h, ${before.pounds.toFixed(2)} lb), ` +
        `of which ${u.estimatedPounds.toFixed(2)} lb is estimated from SWG entries before the output log began${u.firstHour ? ` (${u.firstHour})` : ''}` +
        `${u.cycleHourCount > 0 ? `; ${u.cycleHourCount} logged hours counted by ${chlor.cycleHours} h cycles from the power log` : ''}.`);
    return u;
}

export function poolGallons(): number {
    if (sys.poolMath.gallons > 0) return sys.poolMath.gallons;
    let cap = 0;
    for (const b of sys.bodies.toArray()) if (b.capacity > cap) cap = b.capacity;
    return cap;
}

// Checks the cell settings of a chlorinator save: the rating (lb/day, 0 or empty for the default), the install date (YYYY-MM-DD, or
// empty), the cycle length (hours, 0 to 24) and the two cycle switches. Throws on a bad value.
export function checkCellSettings(obj: any): { lbs?: number; date?: string; cycleHours?: number; cycleRestartsOnPower?: boolean; burstFirst?: boolean } {
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
    let cycleHours: number | undefined;
    if (typeof obj.cycleHours !== 'undefined' && obj.cycleHours !== null && obj.cycleHours !== '') {
        cycleHours = Number(obj.cycleHours);
        if (!Number.isFinite(cycleHours) || cycleHours < 0 || cycleHours > 24) throw new ServiceParameterError('The cycle length must be a number of hours from 0 to 24.', 'setCellSettings', 'cycleHours', obj.cycleHours);
    }
    const flag = (name: string): boolean | undefined => {
        const v = obj[name];
        if (typeof v === 'undefined' || v === null || v === '') return undefined;
        if (v === true || v === 'true' || v === 1 || v === '1') return true;
        if (v === false || v === 'false' || v === 0 || v === '0') return false;
        throw new ServiceParameterError(`${name} must be true or false.`, 'setCellSettings', name, v);
    };
    return { lbs, date, cycleHours, cycleRestartsOnPower: flag('cycleRestartsOnPower'), burstFirst: flag('burstFirst') };
}

// Applies the cell settings from a chlorinator save (PUT /config/chlorinator) and recounts the usage when the install date, the rating
// or a cycle setting changed.
export function setCellSettings(id: number, obj: any) {
    const keys = ['cellLbsPerDay', 'cellInstalledDate', 'cycleHours', 'cycleRestartsOnPower', 'burstFirst'];
    if (!obj || !keys.some(k => typeof obj[k] !== 'undefined')) return;
    const chlor = sys.chlorinators.find(c => c.id === id);
    if (!chlor) return;
    const v = checkCellSettings(obj);
    const before = JSON.stringify([chlor.cellLbsPerDay, chlor.cellInstalledDate, chlor.cycleHours, chlor.cycleRestartsOnPower, chlor.burstFirst]);
    if (typeof obj.cellLbsPerDay !== 'undefined') chlor.cellLbsPerDay = v.lbs;
    if (typeof v.date !== 'undefined') chlor.cellInstalledDate = v.date;
    if (typeof v.cycleHours !== 'undefined') chlor.cycleHours = v.cycleHours;
    if (typeof v.cycleRestartsOnPower !== 'undefined') chlor.cycleRestartsOnPower = v.cycleRestartsOnPower;
    if (typeof v.burstFirst !== 'undefined') chlor.burstFirst = v.burstFirst;
    const after = JSON.stringify([chlor.cellLbsPerDay, chlor.cellInstalledDate, chlor.cycleHours, chlor.cycleRestartsOnPower, chlor.burstFirst]);
    if (chlor.cellInstalledDate && after !== before) recountCellUsage(id);
}

export function cellUsageInfo(id: number) {
    const chlor = sys.chlorinators.find(c => c.id === id);
    const s = state.chlorinators.getItemById(id, false);
    if (!chlor || !s) return undefined;
    const events = chlorinatorPowerLog.read(1461, Date.now(), id);
    const first = events.length ? events[0] : undefined, last = chlorinatorPowerLog.lastEvent(id);
    return {
        id: id,
        hours: Math.round(s.usageHours * 10) / 10, runHours: Math.round(s.usageRunHours * 10) / 10,
        pounds: Math.round(s.usagePounds * 100) / 100, estimatedPounds: Math.round(s.usageEstimatedPounds * 100) / 100,
        since: s.usageSince > 0 ? new Date(s.usageSince).toISOString() : '',
        installedDate: chlor.cellInstalledDate, lbsPerDay: chlor.cellLbsPerDay, lbsPerDaySetting: chlor.cellLbsPerDaySetting,
        cycleHours: chlor.cycleHours, cycleRestartsOnPower: chlor.cycleRestartsOnPower, burstFirst: chlor.burstFirst,
        // with a cycle length, the hours from the first power event on are counted by cycles; the hours before by their mean output
        cycleSince: chlor.cycleHours > 0 && first ? first.t : '',
        powered: last ? last.on : undefined
    };
}

export function startChlorinatorLog() {
    if (timer) return;
    chlorinatorLog.onHour = creditHour;
    markPowerOffWhileStopped();
    // the power every 15 seconds, from half a minute after start (when the bodies' state is known)
    powerTimer = setTimeout(function check() {
        try { checkChlorinatorPower(); } catch (err) { logger.warn(`Chlorinator power log: ${err.message}`); }
        powerTimer = setTimeout(check, POWER_CHECK_MS);
    }, 30000);
    // a first sample a minute after start, when the chlorinators have reported, then every ten minutes
    timer = setTimeout(function tick() {
        try { sampleChlorinators(); } catch (err) { logger.warn(`Chlorinator log: ${err.message}`); }
        timer = setTimeout(tick, SAMPLE_MS);
    }, 60000);
}

export function stopChlorinatorLog() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (powerTimer) { clearTimeout(powerTimer); powerTimer = undefined; }
    markPowerOffWhileStopped();
    try { chlorinatorLog.flush(); } catch (err) { logger.warn(`Chlorinator log: could not write the last hour: ${err.message}`); }
}
