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

// SWG Assist range control: keep FC between a low and a high value instead of steering to one target. It has no imports so it can be tested alone.
// The rules (a closed-loop backtest of them against the point target is in the project notes):
//   Inside the range the SWG runs the maintenance % (what matches the average burn), trimmed up to `trim` of itself toward the middle of the range:
//     a little less when FC is in the top half, a little more in the bottom half. The trim never lowers the output on a reading older than 1.5 days.
//   Below the range (the projected FC, less an allowance that grows with the age of the reading, is under the low value) the % is raised enough to bring FC
//     to the middle of the range over one run period, never less than the maintenance %.
//   Above the range the SWG is held at 0% (coasting) until the projected FC is half a ppm below the high value. The coasting state is kept between
//     checks by the caller (`coasting`), and it never lasts past a reading 2 days old.
//   A reading older than 2 days adds a bias above the maintenance % (biasPerDay for each day beyond 2, at most 40%), so that a projection that has stopped
//     following the pool cannot leave the SWG below what the burn needs.
// The projection is open loop between tests, so the range should be wider than the projection's usual error (about 3 ppm).

export interface BandInput {
    projectedFc: number;        // the projected FC now (ppm)
    avgPerDay: number;          // the average burn (ppm per day)
    elapsedDays: number;        // age of the last FC reading, in days
    low: number;                // the range (ppm)
    high: number;
    trim: number;               // how much of the maintenance % the trim may add or take off, 0 to 1 (default 0.2)
    biasPerDay: number;         // bias above the maintenance % for each day a reading is older than 2 days (default 0.05)
    guardPerDay: number;        // allowance added to the projection's low test for each day of reading age (default 0.3), up to guardCap
    guardCap: number;           // default 2
    maintenancePct: number;     // the % that matches the average burn, 0 to 100
    marginPpm: number;          // how far above the middle of the range to aim when boosting (grows with the age of the reading)
    periodDayEq: number;        // days of consumption in the period one run window ahead (daylight weighted)
    periodRunHours: number;     // hours the SWG is on in that period
    ppmPerHourAtFull: number;   // ppm the cell adds per run-window hour at 100%
    coasting: boolean;          // the state returned by the last decision that was applied
}

export type BandMode = 'coast' | 'boost' | 'hold';
export interface BandDecision {
    pct: number;                // unrounded, 0 to 100
    mode: BandMode;
    coasting: boolean;          // keep this for the next decision
    middle: number;
    note: string;               // one line for the rationale
}

function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

export function bandDecision(i: BandInput): BandDecision {
    const lo = i.low, hi = i.high;
    const mid = (lo + hi) / 2, half = (hi - lo) / 2;
    const guard = Math.min(i.guardCap, i.guardPerDay * i.elapsedDays);
    const stale = i.elapsedDays >= 3;
    let coasting = i.coasting;
    if (i.projectedFc > hi) coasting = true;
    else if (i.projectedFc <= hi - 0.5) coasting = false;
    let pct: number;
    let mode: BandMode;
    let note: string;
    if (coasting && !stale) {
        pct = 0; mode = 'coast';
        note = `FC is projected at ${i.projectedFc.toFixed(2)} ppm, above the top of the range (${hi} ppm), so the SWG is held at 0% until it falls to ${(hi - 0.5).toFixed(1)} ppm.`;
    }
    else if (i.projectedFc - guard < lo) {
        const need = mid + i.marginPpm - i.projectedFc + i.avgPerDay * i.periodDayEq;
        const raw = (need / (i.ppmPerHourAtFull * Math.max(i.periodRunHours, 0.1))) * 100;
        pct = clamp(raw, i.maintenancePct, 100); mode = 'boost';
        note = `FC is projected at ${i.projectedFc.toFixed(2)} ppm${guard > 0.05 ? ` (${guard.toFixed(1)} ppm of allowance for a ${i.elapsedDays.toFixed(1)} day old reading)` : ''}, below the bottom of the range (${lo} ppm), so the SWG is raised to bring FC to ${mid.toFixed(1)} ppm over one run period.`;
    }
    else {
        let trim = clamp((i.projectedFc - mid) / half, -1, 1) * i.trim;
        if (trim > 0 && i.elapsedDays > 1.5) trim = 0;
        pct = clamp(i.maintenancePct * (1 - trim), 0, 100); mode = 'hold';
        const trimText = Math.abs(trim) >= 0.005 ? `, ${trim > 0 ? 'trimmed down' : 'trimmed up'} ${Math.abs(trim * 100).toFixed(0)}% toward the middle` : '';
        if (i.projectedFc > hi) note = `FC is projected at ${i.projectedFc.toFixed(2)} ppm, above the top of the range (${hi} ppm), but the last reading is ${i.elapsedDays.toFixed(1)} days old and the projection cannot be trusted that far, so the SWG is not held at 0%: it runs the maintenance % of ${i.maintenancePct.toFixed(1)}%.`;
        else note = `FC is projected at ${i.projectedFc.toFixed(2)} ppm, inside the range (${lo} to ${hi} ppm), so the SWG holds the maintenance % of ${i.maintenancePct.toFixed(1)}%${trimText}.`;
    }
    if (i.elapsedDays > 2) {
        const floor = i.maintenancePct * (1 + Math.min(0.4, i.biasPerDay * (i.elapsedDays - 2)));
        if (pct < floor) {
            pct = floor;
            note += ` The last reading is ${i.elapsedDays.toFixed(1)} days old, so the SWG runs at no less than ${floor.toFixed(1)}% (the maintenance % plus a bias for the age of the reading).`;
        }
    }
    return { pct: clamp(pct, 0, 100), mode: mode, coasting: coasting, middle: mid, note: note };
}
