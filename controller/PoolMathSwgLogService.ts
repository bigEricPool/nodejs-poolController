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

// Runs the PoolMath SWG log (PoolMathSwgLog.ts) for the configured chlorinator: one PoolMath client for the life of the process (one
// sign-in per start, plus one each time the token expires), checked every 15 seconds. The settings are swgLogEnabled, swgLogScheduleId
// and swgLogHours in the poolMath section of poolConfig.json (PUT /config/poolMath); the status is GET /state/poolMath/swgLog.

import * as path from 'path';
import { logger } from '../logger/Logger';
import { sys } from './Equipment';
import { state } from './State';
import { poolGallons } from './ChlorinatorLogService';
import { onSuperChlorRunEnded } from './ChlorinatorSuperChlorLog';
import { PoolMathClient } from './PoolMathClient';
import { SwgLogReading, SwgLogSettings, SwgLogStatus, SwgLogWriter } from './PoolMathSwgLog';

const CHECK_MS = 15 * 1000;
let writer: SwgLogWriter | undefined;
let timer: NodeJS.Timeout | undefined;
let feederName: string | undefined;

// A module that keeps its own record of the SWG's changes registers here (by a short name shown in the status), and hands in each change
// it records with submitPoolMathSwgEntry: the PoolMath entries then carry its exact time, rate and hours, and the % setting is not watched.
// undefined unregisters it (the setting is watched again).
export function setPoolMathSwgFeeder(name: string | undefined) {
    const n = typeof name === 'string' && name.trim() ? name.trim().substring(0, 40) : undefined;
    if (n !== feederName) logger.info(n ? `PoolMath SWG log: SWG changes now come from ${n}.` : 'PoolMath SWG log: SWG changes are taken from the chlorinator % setting again.');
    feederName = n;
}
// One SWG change from the registered feeder: when it happened (ms, ISO string or Date), the %, the run hours a day it was worked out for
// (exact; PoolMath gets them rounded to whole hours) and the FC ppm a day it makes. Returns whether it was taken.
export function submitPoolMathSwgEntry(e: { ts: number | string | Date; percent: number; hours: number; ppmPerDay: number }): boolean {
    if (!writer || !feederName || !e) return false;
    const ts = e.ts instanceof Date ? e.ts.getTime() : typeof e.ts === 'string' ? Date.parse(e.ts) : e.ts;
    return writer.submit({ ts, percent: Number(e.percent), hours: Number(e.hours), ppm: Number(e.ppmPerDay) });
}

// The whole hours of a run window (one ending before it starts runs past midnight); 0 when there is none.
export function windowHours(start: Date | null | undefined, end: Date | null | undefined): number {
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
    let ms = end.getTime() - start.getTime();
    if (ms <= 0) ms += 24 * 3600 * 1000;
    const h = Math.round(ms / 3600000);
    return h >= 1 && h <= 24 ? h : 0;
}

// The run hours sent with each entry: the chosen schedule's window for the day (sunrise/sunset times as calculated for today), else the
// hours set by hand.
export function swgLogSettings(): SwgLogSettings {
    const pm = sys.poolMath;
    const set = { enabled: pm.swgLogEnabled, hours: pm.swgLogHours, hoursSource: 'set' as 'schedule' | 'set', hoursNote: undefined as string };
    const id = pm.swgLogScheduleId;
    if (id < 0) return set;
    const fallback = pm.swgLogHours > 0 ? `the ${pm.swgLogHours} h set by hand are used` : 'nothing is written until it has one or run hours are set';
    const sched = sys.schedules.toArray().find(s => s.id === id);
    if (!sched || sched.disabled) { set.hoursNote = `Schedule #${id} is missing or disabled, so ${fallback}.`; return set; }
    let hours = 0;
    try {
        const t = state.schedules.getItemById(id, false).scheduleTime.calcScheduleDate(state.time, sched);
        hours = windowHours(t.startTime, t.endTime);
    } catch (err) { /* below */ }
    if (!(hours > 0) && typeof sched.startTime === 'number' && typeof sched.endTime === 'number') {
        const base = new Date(2026, 0, 1);
        hours = windowHours(new Date(base.getTime() + sched.startTime * 60000), new Date(base.getTime() + sched.endTime * 60000));
    }
    if (!(hours > 0)) { set.hoursNote = `Schedule #${id} has no run window today, so ${fallback}.`; return set; }
    return { enabled: pm.swgLogEnabled, hours, hoursSource: 'schedule', hoursNote: `${hours} h from schedule #${id} (circuit ${sched.circuit}), rounded to whole hours.` };
}

function reading(): SwgLogReading {
    const chlors = sys.chlorinators.toArray();
    if (chlors.length !== 1) return { ok: false, reason: chlors.length ? 'PoolMath SWG entries are written only when there is one chlorinator.' : 'No chlorinator is configured.' };
    const c = chlors[0];
    const pct = c.poolSetpoint;
    if (typeof pct !== 'number' || !isFinite(pct)) return { ok: false, reason: 'The chlorinator has no pool % yet.' };
    const lbs = c.cellLbsPerDay;
    const gallons = poolGallons();
    if (!(lbs > 0) || !(gallons > 0)) return { ok: false, reason: 'The cell rating or the pool volume is not known, so the FC cannot be worked out.' };
    return { ok: true, percent: pct, superChlorOn: state.chlorinators.getItemById(c.id).superChlor === true, lbsPerDay: lbs, gallons };
}

export function startPoolMathSwgLog() {
    if (writer) return;
    writer = new SwgLogWriter({
        client: new PoolMathClient({ userAgent: `nodejs-poolController/${sys.appVersion || ''} (PoolMath SWG log)` }),
        settings: swgLogSettings,
        reading,
        file: path.join(process.cwd(), 'data', 'poolMathSwgLog.json'),
        feeder: () => feederName
    });
    writer.start();
    onSuperChlorRunEnded(run => { if (writer) writer.superChlorEnded(run); });
    timer = setTimeout(function check() {
        const w = writer;
        if (!w) return;
        w.tick().finally(() => { if (writer) timer = setTimeout(check, CHECK_MS); });
    }, CHECK_MS);
    timer.unref();
}

export function stopPoolMathSwgLog() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    writer = undefined;
}

export function poolMathSwgLogStatus(): SwgLogStatus | { enabled: boolean } {
    return writer ? writer.status() : { enabled: sys.poolMath.swgLogEnabled };
}

// swgLogEnabled (true/false), swgLogHours (whole hours from 1 to 24; 0 or null clears it) and swgLogScheduleId (a schedule's id, or -1
// or null for the hours set by hand) from PUT /config/poolMath.
export function setPoolMathSwgLogSettings(obj: any) {
    if (!obj) return;
    if (typeof obj.swgLogScheduleId !== 'undefined') {
        const v = obj.swgLogScheduleId === null || obj.swgLogScheduleId === '' ? -1 : Number(obj.swgLogScheduleId);
        if (!Number.isInteger(v) || v < -1) throw new RangeError('swgLogScheduleId must be a schedule id, or -1 for the run hours set by hand.');
        if (v >= 0 && !sys.schedules.toArray().some(s => s.id === v)) throw new RangeError(`There is no schedule #${v}.`);
        sys.poolMath.swgLogScheduleId = v;
    }
    if (typeof obj.swgLogHours !== 'undefined') {
        const v = obj.swgLogHours === null || obj.swgLogHours === '' ? 0 : Number(obj.swgLogHours);
        if (!Number.isInteger(v) || v < 0 || v > 24) throw new RangeError('The SWG run hours a day must be a whole number of hours from 1 to 24 (0 clears it).');
        sys.poolMath.swgLogHours = v;
    }
    if (typeof obj.swgLogEnabled !== 'undefined') {
        if (typeof obj.swgLogEnabled !== 'boolean') throw new RangeError('swgLogEnabled must be true or false.');
        if (obj.swgLogEnabled !== sys.poolMath.swgLogEnabled) logger.info(`PoolMath SWG log: writing to PoolMath turned ${obj.swgLogEnabled ? 'on' : 'off'}.`);
        sys.poolMath.swgLogEnabled = obj.swgLogEnabled;
    }
}
