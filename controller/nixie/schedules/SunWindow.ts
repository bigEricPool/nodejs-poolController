/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022.
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
// Sun window schedules.  A sun window schedule keeps plain fixed start and end times, but those
// times are rewritten each day so the window covers sunrise to sunset with a length that is the
// smallest multiple of N whole hours.  This module holds the pure math so it can be unit tested
// without the controller singletons.

export const SUN_WINDOW_DEFAULT_HOURS = 3;
export const SUN_WINDOW_MAX_HOURS = 24;
const MS_PER_MIN = 60000;
const MS_PER_HOUR = 3600000;
// Daylight within this much of an exact multiple counts as that multiple.  Sun times carry
// seconds, so 12h 00m 00.4s should still give a 12 h window with N=3.
const EXACT_TOLERANCE_MS = 1000;

export interface SunWindowTimes {
    startTime: number;      // Minutes after local midnight.
    endTime: number;        // Minutes after local midnight.  Less than startTime when the window crosses midnight.
    lengthMinutes: number;  // Window length.  Always a multiple of 60 * hourMultiple, capped at 24 h.
}

function isValidDate(dt: any): dt is Date { return dt instanceof Date && !isNaN(dt.getTime()); }
function minuteOfDay(dt: Date): number { return dt.getHours() * 60 + dt.getMinutes(); }

/**
 * Calculates the sun window for one day.
 * @param sunrise The day's sunrise.
 * @param sunset The day's sunset.
 * @param hourMultiple N, a whole number of hours from 1 to 24.
 * @param placement 'solarNoon' (centred on the midpoint of sunrise and sunset), 'sunrise' (starts at sunrise)
 * or 'sunset' (ends at sunset).  Anything else is treated as 'solarNoon'.
 * @returns The window in local minutes, or undefined when the inputs cannot give a window.
 */
export function calcSunWindow(sunrise: Date, sunset: Date, hourMultiple: number, placement: string): SunWindowTimes {
    if (!isValidDate(sunrise) || !isValidDate(sunset)) return undefined;
    if (typeof hourMultiple !== 'number' || !Number.isInteger(hourMultiple) || hourMultiple < 1 || hourMultiple > SUN_WINDOW_MAX_HOURS) return undefined;
    let daylightMs = sunset.getTime() - sunrise.getTime();
    if (daylightMs <= 0) return undefined;
    let blockMs = hourMultiple * MS_PER_HOUR;
    let blocks = Math.max(1, Math.ceil((daylightMs - EXACT_TOLERANCE_MS) / blockMs));
    let lengthMs = Math.min(blocks * blockMs, SUN_WINDOW_MAX_HOURS * MS_PER_HOUR);
    let startMs: number;
    switch (placement) {
        case 'sunrise':
            startMs = Math.floor(sunrise.getTime() / MS_PER_MIN) * MS_PER_MIN;
            break;
        case 'sunset':
            startMs = Math.floor(sunset.getTime() / MS_PER_MIN) * MS_PER_MIN - lengthMs;
            break;
        default: {
            let noonMs = (sunrise.getTime() + sunset.getTime()) / 2;
            startMs = Math.round((noonMs - lengthMs / 2) / MS_PER_MIN) * MS_PER_MIN;
            break;
        }
    }
    // The start comes from real sun times converted to the local clock, so DST change days follow
    // the clock.  The end is the start plus the length on the clock, which is how the schedule run
    // logic reads a fixed end time; a 24 h window therefore ends at its own start minute.
    let lengthMinutes = Math.round(lengthMs / MS_PER_MIN);
    let startTime = minuteOfDay(new Date(startMs));
    return { startTime: startTime, endTime: (startTime + lengthMinutes) % 1440, lengthMinutes: lengthMinutes };
}

export interface ISunWindowSchedule {
    id: number;
    startTime: number;
    endTime: number;
    hourMultiple: number;
    placement: string;
}
export interface ISunWindowChange extends SunWindowTimes { id: number; }

/**
 * Decides which sun window schedules need new times.  It holds only the warn-once flag for
 * missing sun times, which is per-process logging bookkeeping and is not persisted.
 */
export class SunWindowTracker {
    private _warned: boolean = false;
    public get warned(): boolean { return this._warned; }
    public refresh(schedules: ISunWindowSchedule[], sunrise: Date, sunset: Date, warn: (msg: string) => void): ISunWindowChange[] {
        let changes: ISunWindowChange[] = [];
        if (!Array.isArray(schedules) || schedules.length === 0) return changes;
        let known = isValidDate(sunrise) && isValidDate(sunset) && sunset.getTime() > sunrise.getTime();
        if (!known) {
            if (!this._warned) {
                this._warned = true;
                warn(`Sun window schedules: sunrise/sunset are not known (check the location); keeping the last times for schedule(s) ${schedules.map(s => s.id).join(', ')}`);
            }
            return changes;
        }
        this._warned = false;
        for (let i = 0; i < schedules.length; i++) {
            let s = schedules[i];
            let w = calcSunWindow(sunrise, sunset, s.hourMultiple, s.placement);
            if (typeof w === 'undefined') continue;
            if (w.startTime !== s.startTime || w.endTime !== s.endTime) changes.push({ id: s.id, startTime: w.startTime, endTime: w.endTime, lengthMinutes: w.lengthMinutes });
        }
        return changes;
    }
}
