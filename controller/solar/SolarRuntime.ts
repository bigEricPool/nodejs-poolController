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
// The solar decision's memory between status passes, per heater and per body. Session-only by design (AGENTS.md rule 2): none of it
// needs to survive a restart.
export const SOLAR_START_WATCH_MS = 10 * 60 * 1000;
// How often the readings are logged while solar runs (see runLogAt).
export const SOLAR_RUN_LOG_MS = 5 * 60 * 1000;
// The return hold (controller.solar.returnHold): the return gain is averaged over this long, and the collector must still lead the water by more
// than SOLAR_RETURN_FLOOR degrees, so a return sensor that sticks or fails cannot keep the pump on at its solar speed.
export const SOLAR_RETURN_WINDOW_MS = 5 * 60 * 1000;
export const SOLAR_RETURN_FLOOR = 1;
// The first minutes of a run are left out of the return average: the water that stood in the return pipe reaches the sensor first, cold in the
// morning and hot after it sat in the sun (+10 over the water at a start on 12 November 2026), and is not heat the panels are delivering.
export const SOLAR_RETURN_FLUSH_MS = 5 * 60 * 1000;
export class SolarRuntime {
    // The last solar decision logged for each heater id (see the 'warn-solar' log level), so only a change is logged.
    public logged: Map<number, string> = new Map<number, string>();
    // What was last said about why solar is enabled but not running, per heater, so it is said when the reason changes and then
    // only every 15 minutes (see the 'warn-solar' log level).
    public whyNot: Map<number, { key: string; at: number }> = new Map<number, { key: string; at: number }>();
    // A reason that differs from the one last logged, and since when it has held (it is logged once it has held for two minutes).
    public whyNotPending: Map<number, { key: string; since: number }> = new Map<number, { key: string; since: number }>();
    // When each body's pump was first seen running by this process, and what was last logged about a solar settle delay, per heater.
    public bodyOnAt: Map<number, number> = new Map<number, number>();
    public settleLog: Map<number, { key: string; at: number }> = new Map<number, { key: string; at: number }>();
    // When the water first reached the level that stops solar, per heater, and has stayed there since (see solarSettleMs).
    public stopSince: Map<number, number> = new Map<number, number>();
    // Heaters whose stop has been explained in the log, so repeated status passes while the relay manager answers do not log it again.
    public offNoted: Set<number> = new Set<number>();
    // When the reheat guard was set, per heater, and whether it was night on the heater's last pass. The guard is there for a cloud or a dip in the
    // sun, a matter of minutes. A guard left from an evening stop held solar off the next morning until the collector passed that evening's
    // temperature plus the start delta, so it is cleared at sunset, and when the body's pump has started since it was set (the body was off, or a
    // pump primed after a stop).
    public guardAt: Map<number, number> = new Map<number, number>();
    public wasNight: Map<number, boolean> = new Map<number, boolean>();
    // The pump start (bodyOnAt of the body) for which the first check has been made, per heater. See the first check in syncHeaterStates.
    public firstCheck: Map<number, number> = new Map<number, number>();
    // Per body, the water reading at the end of a priming run and when priming ended, so that the reading a minute later at the normal speed can be
    // logged beside it: the difference priming shows between the speeds, for comparison with the one the solar checks measure.
    public primeWatch: Map<number, { high: number; endAt: number }> = new Map<number, { high: number; endAt: number }>();
    // The heaters whose start is waiting out the valve delay: when it began, the body, the status pass that last found the start wanted, whether the
    // delay is over and the valve relay is being switched on, the water and collector readings when the pump sped up (to show what the speed-up did to
    // them), when the progress was last logged, and the temperature a dashboard is to show while the check runs: the reading at the solar pump speed
    // from the check before, when that was still being shown (star), and otherwise the reading from just before the pump sped up.
    public valveTrial: Map<number, { at: number; bodyId: number; pass: number; done: boolean; water: number; solar: number; noteAt: number; cool?: boolean; shown: { temp: number; at: number; star: boolean } }> = new Map<number, { at: number; bodyId: number; pass: number; done: boolean; water: number; solar: number; noteAt: number; cool?: boolean; shown: { temp: number; at: number; star: boolean } }>();
    // The start the valve delay check last turned down, per heater: when, what the water read at the solar pump speed, and the setpoints it was judged
    // against. The start is not checked again until the solar check period is over (solarCheckPeriodMs), so the pump is not sped up again and again.
    public valveFailed: Map<number, { at: number; water: number; heatSet: number; coolSet: number }> = new Map<number, { at: number; water: number; heatSet: number; coolSet: number }>();
    // At log level verbose, the readings for the first ten minutes after solar turns on, every 30 s, with their change since it turned on: what opening
    // the valve does to the water and collector readings (the flow through the collector changes what reaches the sensor) shows whether a settle period
    // is needed after the valve opens too. Per heater: when solar turned on, the readings then, and when a line was last logged.
    public startWatch: Map<number, { at: number; water: number; solar: number; noteAt: number }> = new Map<number, { at: number; water: number; solar: number; noteAt: number }>();
    // While solar runs, when its readings were last put in the solar log, per heater: they are logged every SOLAR_RUN_LOG_MS, so a run shows how the
    // collector and, with a return sensor, the heat it delivers change through the day. Nothing else in the log covers a run between its start and stop.
    public runLogAt: Map<number, number> = new Map<number, number>();
    // For the return hold, per heater, while a heating run is on: the return's gain over the water, sampled every 10 s over the last
    // SOLAR_RETURN_WINDOW_MS; whether the average has come up to returnHoldGain since the run began; and, while the hold is keeping the run
    // going past the collector stop, when that began and the water then.
    public returnGains: Map<number, { at: number; gain: number }[]> = new Map<number, { at: number; gain: number }[]>();
    public returnUp: Set<number> = new Set<number>();
    public returnHeld: Map<number, { at: number; water: number }> = new Map<number, { at: number; water: number }>();
    // The water reading from the last pass on which solar was running, per heater, and when that was. After solar turns off the pump goes back to its
    // normal speed and the sensor reads lower, so a dashboard is given this reading (marked, with its time) in place of the live one until the next
    // valve delay check replaces it, or for the solar check period at most.
    public runReading: Map<number, { temp: number; at: number }> = new Map<number, { temp: number; at: number }>();
    // What the valve delay has done today, per heater, so the solar log shows what it costs and what it buys: the starts that went ahead, the starts it turned
    // down, the delays cancelled, and the seconds the pump ran at its solar speed with the valve closed (before a start, and with no start).
    public valveStats: Map<number, { day: string; started: number; turnedDown: number; cancelled: number; leadSecs: number; wastedSecs: number }> = new Map<number, { day: string; started: number; turnedDown: number; cancelled: number; leadSecs: number; wastedSecs: number }>();
    public valveTally(heaterId: number, outcome: string, secs: number): string {
        const day = new Date().toDateString();
        let st = this.valveStats.get(heaterId);
        if (typeof st === 'undefined' || st.day !== day) {
            st = { day: day, started: 0, turnedDown: 0, cancelled: 0, leadSecs: 0, wastedSecs: 0 };
            this.valveStats.set(heaterId, st);
        }
        if (outcome === 'started') { st.started++; st.leadSecs += secs; }
        else {
            if (outcome === 'turnedDown') st.turnedDown++; else st.cancelled++;
            st.wastedSecs += secs;
        }
        const min = (v: number) => Math.round(v / 6) / 10;
        return `valve delay today: ${st.started} went on to start solar, ${st.turnedDown} turned down, ${st.cancelled} cancelled; the pump ran at its solar speed with the valve closed ${min(st.leadSecs)} min before starts and ${min(st.wastedSecs)} min with no start`;
    }
    // Counts the passes of syncHeaterStates, so a valve delay that is no longer wanted can be found and dropped.
    public pass = 0;
    // Whether a start on the body is waiting out the valve delay. The virtual solar circuit is on for it, so the pump runs at its solar speed.
    public isValveCheckRunning(bodyId: number): boolean {
        let waiting = false;
        this.valveTrial.forEach((t) => { if (t.bodyId === bodyId) waiting = true; });
        return waiting;
    }
}
export const solarRuntime = new SolarRuntime();
