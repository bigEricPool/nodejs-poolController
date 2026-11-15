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

// Whether a chlorinator has power. The chlorinator's own settings decide first:
//   powerRelays           the relays its power is wired through (a dead-man, for example the cell's own relay and the pump's low speed relay):
//                         it has power only while every one is on. Their state is what njsPC already knows: a relay of a pump from that pump's
//                         relay bits, any other from the circuit bound to it (the relay manager is never asked).
//   powerConfirmByComms   the chlorinator answering on RS-485 is proof of power: one that answered in the last COMM_FRESH_SEC has power. With
//                         relays, the relays time each change and the link confirms it; when they disagree the answer wins (a cell without
//                         power cannot answer) and a warning says the relay setting or the wiring does not match, and relays on with no answer
//                         for COMM_SILENT_SEC are logged as unconfirmed (it may be the link). Without relays the link decides on its own.
// With neither setting: the default is that its body is on, and another module can say otherwise for its wiring (setChlorinatorPowerSource;
// the source returns undefined when it cannot tell, and the default is used).
export type ChlorinatorPowerSource = (chlor: Chlorinator) => boolean | undefined;
let powerSource: ChlorinatorPowerSource | undefined;
export function setChlorinatorPowerSource(fn: ChlorinatorPowerSource | undefined) { powerSource = fn; }
export const COMM_FRESH_SEC = 30;     // Nixie asks the chlorinator every 3 seconds
export const COMM_SILENT_SEC = 60;
export type PowerBy = 'relays' | 'comms' | 'source' | 'body';
export interface PowerDecision { on: boolean | undefined; by: PowerBy; confirmed?: boolean; mismatch?: 'answering' | 'silent'; }
// The rule above, given what is known: each relay's state (undefined: not known), the seconds since the chlorinator last answered
// (undefined: never), how long the relays have all been on (seconds), and the old answer.
export function decidePower(relays: (boolean | undefined)[], commAgeSec: number | undefined, confirmByComms: boolean, relaysOnForSec: number, fallback: () => { on: boolean | undefined; by: PowerBy }): PowerDecision {
    const answering = typeof commAgeSec === 'number' && commAgeSec <= COMM_FRESH_SEC;
    if (relays.length > 0 && relays.every(r => typeof r === 'boolean')) {
        const on = relays.every(r => r === true);
        if (!confirmByComms) return { on: on, by: 'relays' };
        if (!on && answering) return { on: true, by: 'comms', confirmed: false, mismatch: 'answering' };
        if (on && !answering && relaysOnForSec > COMM_SILENT_SEC) return { on: true, by: 'relays', confirmed: false, mismatch: 'silent' };
        return { on: on, by: 'relays', confirmed: on ? answering : true };
    }
    if (confirmByComms && typeof commAgeSec === 'number') return { on: answering, by: 'comms', confirmed: true };
    return fallback();
}
function relayMatches(o: any, r: { connectionId: string; deviceBinding: string }): boolean { return !!o && o.connectionId === r.connectionId && o.deviceBinding === r.deviceBinding; }
// A relay's state from njsPC's own record: a pump's relay from the pump's relay bits, any other from the circuit bound to it; undefined when
// nothing in njsPC is bound to it.
export function relayIsOn(r: { connectionId: string; deviceBinding: string }): boolean | undefined {
    for (const p of sys.pumps.get()) {
        const relays: any[] = (sys.pumps.getItemById(p.id).relays as any).get() || [];
        for (let i = 0; i < relays.length; i++) {
            if (!relayMatches(relays[i], r)) continue;
            const bits = state.pumps.getItemById(p.id).relay || 0;
            return ((bits >> ((relays[i].id || i + 1) - 1)) & 1) === 1;
        }
    }
    const c = sys.circuits.get().find((x: any) => relayMatches(x, r));
    return c ? state.circuits.getItemById(c.id).isOn === true : undefined;
}
const relaysOnSince = new Map<number, number>();
const lastMismatch = new Map<number, string>();
export function chlorinatorPower(chlor: Chlorinator, now: number = Date.now()): PowerDecision {
    const relays = chlor.powerRelays.map(r => { try { return relayIsOn(r); } catch (err) { return undefined; } });
    const allOn = relays.length > 0 && relays.every(r => r === true);
    if (!allOn) relaysOnSince.delete(chlor.id);
    else if (!relaysOnSince.has(chlor.id)) relaysOnSince.set(chlor.id, now);
    let commAgeSec: number | undefined;
    try {
        const s = state.chlorinators.getItemById(chlor.id, false);
        if (s && typeof s.lastComm === 'number' && s.lastComm > 0) commAgeSec = Math.max(0, (now - s.lastComm) / 1000);
    } catch (err) { /* not known */ }
    const d = decidePower(relays, commAgeSec, chlor.powerConfirmByComms, allOn ? (now - relaysOnSince.get(chlor.id)) / 1000 : 0, () => {
        if (powerSource) {
            try { const v = powerSource(chlor); if (typeof v === 'boolean') return { on: v, by: 'source' }; }
            catch (err) { logger.warn(`Chlorinator power log: the power source failed for chlorinator ${chlor.id}: ${err.message}`); }
        }
        try { return { on: sys.board.bodies.isBodyOn(typeof chlor.body !== 'undefined' ? chlor.body : 0), by: 'body' }; }
        catch (err) { return { on: undefined, by: 'body' }; }
    });
    const m = d.mismatch || '';
    if (m !== (lastMismatch.get(chlor.id) || '')) {
        lastMismatch.set(chlor.id, m);
        if (m === 'answering') logger.warn(`Chlorinator ${chlor.id}: answering on RS-485 while its power relays are off, so it is logged as powered; check its power relay setting and wiring.`);
        else if (m === 'silent') logger.warn(`Chlorinator ${chlor.id}: its power relays are on but it has not answered on RS-485 for over ${COMM_SILENT_SEC} s; still logged as powered (it may be the link).`);
        else logger.info(`Chlorinator ${chlor.id}: its power relays and RS-485 agree again.`);
    }
    return d;
}
export function chlorinatorHasPower(chlor: Chlorinator): boolean | undefined { return chlorinatorPower(chlor).on; }
// Whether a chlorinator should be answering on RS-485, for a controller that polls it (Nixie) to decide how loudly to log a missed answer.
// Only its power relays can say no: while one of them is off, or for POWER_UP_GRACE_SEC after they all came on (the cell starts up), it cannot
// answer, so missed answers are expected and not errors. With no relays set, or a relay njsPC does not know, it should answer (as before).
// One info line is logged when this changes.
export const POWER_UP_GRACE_SEC = 30;
const commsQuiet = new Map<number, boolean>();
export function chlorinatorCommsExpected(chlor: Chlorinator, now: number = Date.now()): boolean {
    let quiet = false;
    try {
        const list = chlor.powerRelays || [];
        if (list.length > 0) {
            const relays = list.map(r => { try { return relayIsOn(r); } catch (err) { return undefined; } });
            if (relays.every(r => typeof r === 'boolean')) {
                if (!relays.every(r => r === true)) { relaysOnSince.delete(chlor.id); quiet = true; }
                else {
                    if (!relaysOnSince.has(chlor.id)) relaysOnSince.set(chlor.id, now);
                    quiet = now - relaysOnSince.get(chlor.id) < POWER_UP_GRACE_SEC * 1000;
                }
            }
        }
    } catch (err) { quiet = false; }
    if (quiet !== (commsQuiet.get(chlor.id) || false)) {
        commsQuiet.set(chlor.id, quiet);
        if (quiet) logger.info(`Chlorinator ${chlor.id}: its power relays say it has no power, so missed RS-485 answers are logged at debug until it has power again.`);
        else logger.info(`Chlorinator ${chlor.id}: its power relays have been on for ${POWER_UP_GRACE_SEC} s, so missed RS-485 answers are logged as errors again.`);
    }
    return !quiet;
}
// Writes each chlorinator's power state when it changed.
export function checkChlorinatorPower(now: number = Date.now()) {
    for (const chlor of sys.chlorinators.toArray()) {
        try {
            const on = chlorinatorHasPower(chlor);
            if (typeof on !== 'boolean') continue;
            const e = chlorinatorPowerLog.record(chlor.id, on, now);
            if (e) logger.info(`Chlorinator ${chlor.id}: power ${on ? 'on' : 'off'}.`);
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
// empty), the cycle length (hours, 0 to 24), the two cycle switches, the power relays (a list of { connectionId, deviceBinding }, at most
// four, empty to clear) and powerConfirmByComms. Throws on a bad value.
export function checkCellSettings(obj: any): { lbs?: number; date?: string; cycleHours?: number; cycleRestartsOnPower?: boolean; burstFirst?: boolean; powerRelays?: { connectionId: string; deviceBinding: string }[]; powerConfirmByComms?: boolean } {
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
    let powerRelays: { connectionId: string; deviceBinding: string }[] | undefined;
    if (typeof obj.powerRelays !== 'undefined') {
        const list = obj.powerRelays === null || obj.powerRelays === '' ? [] : obj.powerRelays;
        if (!Array.isArray(list) || list.length > 4 || !list.every((r: any) => r && typeof r.connectionId === 'string' && r.connectionId && typeof r.deviceBinding === 'string' && r.deviceBinding))
            throw new ServiceParameterError('The power relays must be a list of at most four { connectionId, deviceBinding }.', 'setCellSettings', 'powerRelays', obj.powerRelays);
        powerRelays = list.map((r: any) => ({ connectionId: r.connectionId, deviceBinding: r.deviceBinding }));
    }
    return { lbs, date, cycleHours, cycleRestartsOnPower: flag('cycleRestartsOnPower'), burstFirst: flag('burstFirst'), powerRelays, powerConfirmByComms: flag('powerConfirmByComms') };
}

// Applies the cell settings from a chlorinator save (PUT /config/chlorinator) and recounts the usage when the install date, the rating
// or a cycle setting changed.
export function setCellSettings(id: number, obj: any) {
    const keys = ['cellLbsPerDay', 'cellInstalledDate', 'cycleHours', 'cycleRestartsOnPower', 'burstFirst', 'powerRelays', 'powerConfirmByComms'];
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
    // the power settings change what is logged from now on, not the hours already counted
    if (typeof v.powerRelays !== 'undefined') chlor.powerRelays = v.powerRelays;
    if (typeof v.powerConfirmByComms !== 'undefined') chlor.powerConfirmByComms = v.powerConfirmByComms;
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
        powered: last ? last.on : undefined,
        powerRelays: chlor.powerRelays, powerConfirmByComms: chlor.powerConfirmByComms,
        power: (() => { try { const d = chlorinatorPower(chlor); return { on: d.on, by: d.by, confirmed: d.confirmed, mismatch: d.mismatch }; } catch (err) { return undefined; } })()
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
