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
import { logger } from '../../logger/Logger';
import { Body, Heater, sys } from '../Equipment';
import { BodyTempState, HeaterState, state } from '../State';
import { solarSettleMs, solarHysteresis, solarValveDelayMs, solarReturnTemp, solarCheckPeriodMs, solarStartMargin, solarCoolAnyTime, solarMinRunMs } from './SolarSettings';
import { solarRuntime as rt, SOLAR_START_WATCH_MS, SOLAR_RUN_LOG_MS } from './SolarRuntime';

// What the solar decision is given for one solar heater on one body, from HeaterCommands.syncHeaterStates. isHeating, isCooling,
// heatNote and the solarCheck/solarReturn/solarGain values are the body's values so far in this pass (a second solar heater on the
// body sees what the first left); the result hands them back as the decision leaves them.
export interface SolarContext {
    heater: Heater; hstate: HeaterState; body: BodyTempState; cfgBody: Body; mode: string; bodyHeaters: Heater[];
    isHeating: boolean; isCooling: boolean; heatNote: string;
    solarCheckTemp: number; solarCheckTime: string; solarChecking: boolean; solarReturn: number; solarGain: number;
}
// holdsOthers: a start of solar's own is pending, so the heaters after it in the body's list are not started.
export interface SolarResult {
    isOn: boolean; isHeating: boolean; isCooling: boolean; heatNote: string;
    solarCheckTemp: number; solarCheckTime: string; solarChecking: boolean; solarReturn: number; solarGain: number;
    holdsOthers: boolean;
}
export class SolarDecision {
    // Once per pass of syncHeaterStates, before the bodies: counts the passes, so a valve delay no longer wanted is found at the end.
    public beginPass() {
        rt.pass++;
    }
    // For each body, before its heaters are judged: when its pump was first seen on, restarted while a pump serving it primes, and the
    // priming reading watch.
    public beginBody(body: BodyTempState, cfgBody: Body) {
        let primingNow = false;
        if (!body.isOn) rt.bodyOnAt.delete(body.id);
        else if (!rt.bodyOnAt.has(body.id)) rt.bodyOnAt.set(body.id, new Date().getTime());
        // While a pump that serves this body is priming (its status says so) the readings are not the ones solar runs on, so the settle delay starts
        // when priming is over. A pump serves the body when one of its circuits is the body's circuit or, for a pump with no circuits, when the body it
        // is set to is this one; a pump that says neither is taken to serve it.
        else {
            for (let p = 0; p < state.pumps.length; p++) {
                const pst = state.pumps.getItemByIndex(p);
                const pstatus = pst.status;
                if (!(pstatus > 0) || sys.board.valueMaps.pumpStatus.transform(pstatus).name !== 'priming') continue;
                const pcfg = sys.pumps.getItemById(pst.id);
                let serves = true;
                if (pcfg.circuits.length > 0) {
                    serves = false;
                    for (let c = 0; c < pcfg.circuits.length; c++) if (pcfg.circuits.getItemByIndex(c).circuit === cfgBody.circuit) { serves = true; break; }
                }
                else if (typeof pcfg.body !== 'undefined' && pcfg.body !== null) {
                    const assoc = sys.board.valueMaps.bodies.transform(pcfg.body).name;
                    if (typeof assoc === 'string' && assoc !== 'poolspa') serves = assoc === `body${body.id}` || (assoc === 'pool' && body.id === 1) || (assoc === 'spa' && body.id === 2);
                }
                if (serves) { rt.bodyOnAt.set(body.id, new Date().getTime()); primingNow = true; break; }
            }
        }
        // The difference priming shows between the speeds: the last reading while priming, and the reading a minute after it ended. Logged only.
        {
            const nowP = new Date().getTime();
            const pw = rt.primeWatch.get(body.id);
            if (!body.isOn) rt.primeWatch.delete(body.id);
            else if (primingNow) { if (typeof body.temp === 'number') rt.primeWatch.set(body.id, { high: body.temp, endAt: undefined }); }
            else if (typeof pw !== 'undefined') {
                if (typeof pw.endAt === 'undefined') pw.endAt = nowP;
                else if (nowP - pw.endAt >= 60000 && typeof body.temp === 'number') {
                    let off: number = undefined;
                    for (let h = 0; h < state.heaters.length; h++) { const hs = state.heaters.getItemByIndex(h); if (typeof hs.solarSpeedOffset === 'number') off = hs.solarSpeedOffset; }
                    const d = Math.round((pw.high - body.temp) * 100) / 100;
                    logger.solar(`Solar (${body.name}): after priming the water read ${Math.round(pw.high * 100) / 100} at the priming speed and ${Math.round(body.temp * 100) / 100} a minute later at the normal speed, a difference of ${d >= 0 ? '+' : ''}${d}${typeof off === 'number' ? ` (the last solar check measured ${off >= 0 ? '+' : ''}${off})` : ''}.`);
                    rt.primeWatch.delete(body.id);
                }
            }
        }
    }
    // Once per pass, after the bodies.
    public endPass(heaters: Heater[]) {
        // A start that was waiting out the valve delay and was not found wanted in this pass (the body went off, the heat mode changed, the heater
        // was removed) is dropped, so the pump goes back to its normal speed.
        rt.valveTrial.forEach((t, id) => {
            if (t.pass !== rt.pass) {
                rt.valveTrial.delete(id);
                const secs = Math.round((new Date().getTime() - t.at) / 1000);
                const named = heaters.find(x => x.id === id);
                logger.solar(`Solar ${typeof named !== 'undefined' ? named.name : 'heater ' + id}: the valve delay was cancelled after ${secs} s because the start is no longer wanted (the body, the heat mode or the heater changed); ${rt.valveTally(id, 'cancelled', secs)}.`);
            }
        });
    }
    // Whether a start on the body is waiting out the valve delay (the virtual solar circuit is on for it).
    public isValveCheckRunning(bodyId: number): boolean { return rt.isValveCheckRunning(bodyId); }
    // Whether a start on any body is waiting out the valve delay.
    public isAnyValveCheckRunning(): boolean { return rt.valveTrial.size > 0; }
    // The decision for a solar heater in the Solar and Solar Preferred heat modes. It sets body.heatStatus itself, as it did inline.
    public evaluate(ctx: SolarContext): SolarResult {
        const { heater, hstate, body, cfgBody, mode, bodyHeaters } = ctx;
        let { isHeating, isCooling, heatNote, solarCheckTemp, solarCheckTime, solarChecking, solarReturn, solarGain } = ctx;
        let isOn = false;
        let solarHolds = false;
        /*
            From the manual:
            Screen (3/3): Solar temperature differential start up and run settings.
            Start: Set the temperature differential to start heating from 3° to 9°. For example, if
            “Start” is set to 3°, this ensures that the temperature has to deviate by 3° at least to the
            specified set point temperature (in the Heat menu, on page 25) before it switches on.
            Once the solar comes on it will start converging as it is heating. This ensures that it
            will not continually be switching on and off.
            Run: Set the temperature differential to stop heating from 2° to 5°. This setting sets
            how close to the target set point temperature to switch off solar heat.
        */
        // RSG 04.15.2024 - Updates to heater logic for start/stop deltas.  #925
        // 1.  For all heating cases in order for the heater to turn on, the solar temp > water temp.
        // 2.  If the water temp is below the set point, we want to turn on the heater
        // 3.  But only if the solar collector has risen startTempDelta above prevHeaterOffTemp (collector reheated)
        // 4.  Also only if there is enough heat ('run') to make it worthwhile
        // 5.  The heater should run until it reaches the set point + stop delta
        // 6.  When the heater turns off, note the solar collector temp. Collector reheats quickly in the sun. (#1212)
        let hState: HeaterState =
        state.heaters.getItemById(heater.id);
        {
            const nightNow = state.heliotrope.isNight;
            if (typeof hState.prevHeaterOffTemp !== 'undefined') {
                const guardSetAt = rt.guardAt.get(heater.id);
                const bodyPumpAt = rt.bodyOnAt.get(body.id);
                let clearWhy = '';
                if (rt.wasNight.get(heater.id) === false && nightNow === true) clearWhy = 'the sun has set';
                else if (typeof guardSetAt === 'number' && typeof bodyPumpAt === 'number' && bodyPumpAt > guardSetAt) clearWhy = 'the pump has started again since it was set';
                if (clearWhy !== '') {
                    logger.solar(`Solar ${heater.name} (${body.name}): reheat guard cleared (the collector had to rise ${heater.startTempDelta} above ${Math.round(hState.prevHeaterOffTemp * 10) / 10}): ${clearWhy}.`);
                    hState.prevHeaterOffTemp = undefined;
                    rt.guardAt.delete(heater.id);
                }
            }
            if (typeof nightNow === 'boolean') rt.wasNight.set(heater.id, nightNow);
        }
        // The water temperature is compared as it reads. It used to be truncated to a whole degree (#1248) so that solar would not stop or restart on
        // a reading that had only just touched the setpoint; the hysteresis and the settle delay below do that job, and allow a fractional hysteresis.
        const waterTemp = body.temp;
        // controller.solar.settleMinutes (default 5, 0 turns it off). The water reading is not trustworthy just after the pump starts or the valve
        // moves (warm water standing in the pipes reaches the sensor, and it reads high while solar flows). So solar is not started for the delay after
        // the body's pump starts or after solar turns off, and solar stops for the water only when the water has stayed at the stop level for the whole
        // delay. The panels do the same: "The pump must be ON for a few minutes for operation."
        const settleMs = solarSettleMs();
        const hysteresis = solarHysteresis();
        // The level nocturnal cooling works to: the Cool Point, unless another heater on the body can heat in this mode (gas, MasterTemp or
        // hybrid, as the cases below start them). That heater heats past the Heat Point (gas by its Stop Temp Delta, hybrid by 1), and
        // cooling that started below that level, or cooled under the Heat Point, would take turns with it all night. So with one, cooling
        // works to no lower than the highest level it heats to plus the hysteresis: it starts above that and stops no lower than that level.
        let backupTop: number = undefined, backupName = '';
        for (let k = 0; k < bodyHeaters.length; k++) {
            const bh = bodyHeaters[k];
            if (bh.id === heater.id || bh.master !== 1) continue;
            const bt = sys.board.valueMaps.heaterTypes.transform(bh.type).name;
            let over: number = undefined;
            // Solar runs only in Solar and Solar Preferred: gas and MasterTemp heat in Solar Preferred, hybrid in any mode but off.
            if ((bt === 'gas' || bt === 'maxetherm' || bt === 'jxi' || bt === 'lxi') && mode === 'solarpref') over = typeof bh.stopTempDelta === 'number' ? bh.stopTempDelta : 0;
            else if (bt === 'mastertemp' && mode === 'solarpref') over = 0;
            else if (bt === 'hybrid') over = 1;
            if (typeof over === 'number' && (typeof backupTop === 'undefined' || cfgBody.heatSetpoint + over > backupTop)) { backupTop = cfgBody.heatSetpoint + over; backupName = bh.name; }
        }
        const coolPoint = typeof backupTop === 'number' ? Math.max(cfgBody.coolSetpoint, backupTop + hysteresis) : cfgBody.coolSetpoint;
        const valveMs = solarValveDelayMs();
        const nowMs = new Date().getTime();
        let blockStart = false, waitStop = false, stopNow = false, stopFar = false, holdWhy = '', holdLeftMs = 0, holdTotalMs = settleMs, stopAt = 0, settleHeld = false, failedHold = false;
        if (settleMs > 0) {
            const pumpAt = rt.bodyOnAt.get(body.id);
            const pumpLeft = typeof pumpAt === 'undefined' ? 0 : settleMs - (nowMs - pumpAt);
            const offLeft = typeof hState.endTime === 'undefined' ? 0 : settleMs - (nowMs - hState.endTime.getTime());
            if (!hState.isOn) {
                if (pumpLeft > 0 && pumpLeft >= offLeft) { blockStart = true; holdWhy = 'after the pump started'; holdLeftMs = pumpLeft; }
                else if (offLeft > 0) { blockStart = true; holdWhy = 'after solar turned off'; holdLeftMs = offLeft; }
            }
        }
        // The reading at the solar pump speed that was being shown when a wait ended in this pass. If a check starts now it keeps showing that reading,
        // so the temperature does not fall back to the reading at the normal pump speed for the two minutes of the check.
        let carried: { temp: number; at: number } = undefined;
        // A start that the valve delay check turned down is not checked again until the solar check period is over (at least the settle delay and the
        // valve delay), so the pump is not run at its solar speed again and again while the readings sit near the line. A change of setpoint is
        // checked at once. The reading the check went by, and its time, are published for the dashboard to show in place of the live reading
        // (BodyTempState.solarCheckTemp and solarCheckTime).
        if (valveMs > 0 && !hState.isOn) {
            const failed = rt.valveFailed.get(heater.id);
            if (typeof failed !== 'undefined' && !rt.valveTrial.has(heater.id)) {
                const moved = cfgBody.heatSetpoint !== failed.heatSet || cfgBody.coolSetpoint !== failed.coolSet;
                const failLeft = moved ? 0 : Math.max(solarCheckPeriodMs(), settleMs, valveMs) - (nowMs - failed.at);
                if (failLeft <= 0) {
                    carried = { temp: Math.round(failed.water * 10) / 10, at: failed.at };
                    rt.valveFailed.delete(heater.id);
                }
                else {
                    solarCheckTemp = Math.round(failed.water * 10) / 10;
                    solarCheckTime = new Date(failed.at).toISOString();
                    settleHeld = blockStart; failedHold = true;
                    if (!blockStart || failLeft > holdLeftMs) { blockStart = true; holdWhy = 'after the valve delay check turned the start down'; holdLeftMs = failLeft; holdTotalMs = Math.max(solarCheckPeriodMs(), settleMs, valveMs); }
                }
            }
        }
        // While solar runs it stops for the water at the setpoint plus the hysteresis (heating), or at the cool setpoint minus the hysteresis
        // (cooling), once the water has stayed there for the whole delay. The Cool Point is the cooling target as the Heat Point is the heating one;
        // upstream (#925) cooled only to the cool setpoint plus the run delta. A dip back resets the count. Far past the level (more than the
        // hysteresis, and at least a degree) is not the flow bias the delay is for, for example after the setpoint was changed, so it stops at once.
        if (hState.isOn) {
            const wasCooling = hState.isCooling === true;
            stopAt = wasCooling ? (coolPoint - hysteresis) : (cfgBody.heatSetpoint + hysteresis);
            if (!(wasCooling ? waterTemp <= stopAt : waterTemp >= stopAt)) rt.stopSince.delete(heater.id);
            else {
                if (!rt.stopSince.has(heater.id)) rt.stopSince.set(heater.id, nowMs);
                const waited = nowMs - (rt.stopSince.get(heater.id) as number);
                stopFar = (wasCooling ? stopAt - waterTemp : waterTemp - stopAt) >= Math.max(hysteresis, 1);
                if (waited >= settleMs || stopFar) stopNow = true;
                else { waitStop = true; holdWhy = `waiting to stop (the water must stay ${wasCooling ? 'at or below' : 'at or above'} ${stopAt})`; holdLeftMs = settleMs - waited; }
            }
        }
        else rt.stopSince.delete(heater.id);
        // The water side of the decision: running, it holds until the stop above; stopped, the water must be below the setpoint (heating) or above the
        // cool setpoint (cooling), and after a stop at the target, the hysteresis further.
        const startMargin = solarStartMargin();
        // Nocturnal cooling runs at night, or at any hour with controller.solar.coolAnyTime on.
        const coolTime = state.heliotrope.isNight || solarCoolAnyTime();
        // Early in a run (minRunMinutes after solar turned on) the collector's lead is not a reason to stop; the collector being no warmer (or for
        // cooling no cooler) than the water still is.
        const inMinRun = hState.isOn && typeof hState.startTime !== 'undefined' && hState.startTime !== null && (nowMs - hState.startTime.getTime()) < solarMinRunMs();
        const heatWater = (hState.isOn && hState.isCooling !== true)
            ? !stopNow
            : (waterTemp < cfgBody.heatSetpoint && (hState.targetStop !== 'heating' || waterTemp < (cfgBody.heatSetpoint - hysteresis)));
        const coolWater = (hState.isOn && hState.isCooling === true)
            ? !stopNow
            : (waterTemp > coolPoint
                && (hState.targetStop !== 'cooling' || waterTemp > (coolPoint + hysteresis)));
        const heatOk = state.temps.solar > waterTemp // 1
            && heatWater // 2 and 5
            && (hState.isOn || typeof hState.prevHeaterOffTemp === 'undefined' || ((state.temps.solar - hState.prevHeaterOffTemp) > heater.startTempDelta)) // 3: a rule for starting; a run is not ended by it
            && (inMinRun || (state.temps.solar - waterTemp) > heater.stopTempDelta); // 4, except early in a run (minRunMinutes)
        // reverse logic from heating states
        const coolOk = heater.coolingEnabled
            && coolTime
            && state.temps.solar < waterTemp // 1
            && coolWater // 2 and 5
            && (hState.isOn || typeof hState.prevHeaterOffTemp === 'undefined' || ((hState.prevHeaterOffTemp - state.temps.solar) > heater.startTempDelta)) // 3: a rule for starting; a run is not ended by it
            && (inMinRun || (waterTemp - state.temps.solar) > heater.stopTempDelta); // 4, except early in a run (minRunMinutes)
        // The same decisions as the valve delay check makes them, with the pump at its solar speed. The collector side is the same. The water side
        // is the level solar would stop at, not the level it starts at: the setpoint plus the hysteresis (heating), or the cool setpoint minus the
        // hysteresis (cooling). A start is not turned down for water that solar, once running, would not stop for.
        const heatAtSpeed = state.temps.solar > waterTemp
            && waterTemp < (cfgBody.heatSetpoint + hysteresis)
            && (typeof hState.prevHeaterOffTemp === 'undefined' || ((state.temps.solar - hState.prevHeaterOffTemp) > heater.startTempDelta))
            && (state.temps.solar - waterTemp) > (heater.stopTempDelta + startMargin);
        const coolAtSpeed = heater.coolingEnabled
            && coolTime
            && state.temps.solar < waterTemp
            && waterTemp > (coolPoint - hysteresis)
            && (typeof hState.prevHeaterOffTemp === 'undefined' || ((hState.prevHeaterOffTemp - state.temps.solar) > heater.startTempDelta))
            && (waterTemp - state.temps.solar) > (heater.stopTempDelta + startMargin);
        // What the water is expected to read at the solar pump speed: the reading now plus the difference the last check saw between the two speeds
        // (HeaterState.solarSpeedOffset: the reading at the end of the check minus the reading when it began; positive when the faster speed reads
        // higher). A check is begun only when it should pass on that expected reading, in whichever direction applies:
        // - heating: the start rules hold at the normal speed, and with the expected reading the collector still leads the water by more than the run
        //   delta and the water is still below the stop level. A check begun the moment the lead passed the run delta at the normal speed was turned
        //   down at the solar speed, where the water reads higher, and the check period then kept solar off for an hour of good sun.
        // - cooling: the start rules hold with the expected reading. A reading too cool at the normal speed can be warm enough at the speed cooling
        //   runs at, and a check that waited for the normal-speed reading would never be made.
        // The check itself judges on what it reads. With no check made yet the difference is taken as 0 and the first check measures it.
        const speedOffset = (valveMs > 0 && typeof hState.solarSpeedOffset === 'number' && isFinite(hState.solarSpeedOffset)) ? hState.solarSpeedOffset : 0;
        const waterPred = waterTemp + speedOffset;
        const heatPred = (margin: number) => state.temps.solar > waterPred
            && waterPred < (cfgBody.heatSetpoint + hysteresis - margin)
            && (typeof hState.prevHeaterOffTemp === 'undefined' || ((state.temps.solar - hState.prevHeaterOffTemp) > heater.startTempDelta))
            && (state.temps.solar - waterPred) > (heater.stopTempDelta + startMargin + margin);
        const coolPred = (margin: number) => heater.coolingEnabled
            && coolTime
            && state.temps.solar < waterPred
            && waterPred > (coolPoint + margin)
            && (hState.targetStop !== 'cooling' || waterPred > (coolPoint + hysteresis + margin))
            && (typeof hState.prevHeaterOffTemp === 'undefined' || ((hState.prevHeaterOffTemp - state.temps.solar) > heater.startTempDelta))
            && (waterPred - state.temps.solar) > (heater.stopTempDelta + startMargin + margin);
        const heatBegin = valveMs > 0 ? (heatOk && heatPred(0)) : heatOk;
        const coolBegin = valveMs > 0 ? coolPred(0) : coolOk;
        // The first check since the body's pump started: once the collector side alone would pass (the collector leads the expected reading by
        // more than the run delta, warmer for heating or, at night with nocturnal cooling on, cooler for cooling; and the reheat guard is met), one
        // check is made whatever the water side says. It gives the day a reading taken at the solar pump speed and measures the difference between
        // the speeds afresh; if the water side passes too, solar starts as from any check. Any check made since the pump started counts as the first.
        const pumpStartedAt = rt.bodyOnAt.get(body.id);
        const firstDue = valveMs > 0 && !hState.isOn && typeof pumpStartedAt === 'number' && rt.firstCheck.get(heater.id) !== pumpStartedAt;
        const firstProbe = firstDue && !heatBegin && !coolBegin && (
            (state.temps.solar > waterPred && (state.temps.solar - waterPred) > (heater.stopTempDelta + startMargin)
                && (typeof hState.prevHeaterOffTemp === 'undefined' || ((state.temps.solar - hState.prevHeaterOffTemp) > heater.startTempDelta)))
            || (heater.coolingEnabled && coolTime && state.temps.solar < waterPred && (waterPred - state.temps.solar) > (heater.stopTempDelta + startMargin)
                && (typeof hState.prevHeaterOffTemp === 'undefined' || ((hState.prevHeaterOffTemp - state.temps.solar) > heater.startTempDelta))));
        // With the valve delay in use a start is made by its check and by nothing else.
        const direct = !(valveMs > 0 && !hState.isOn);
        // After a turned-down start the check period need not be waited out when the readings have since moved far enough: the expected reading passes
        // with the hysteresis to spare, and the settle delay has gone by since the pump slowed down again. The difference used is the one the
        // turned-down check itself measured, so at the moment it was turned down this cannot be true.
        if (failedHold && !settleHeld && blockStart) {
            const failed = rt.valveFailed.get(heater.id);
            if (typeof failed !== 'undefined' && (nowMs - failed.at) >= Math.max(settleMs, valveMs) && ((heatOk && heatPred(hysteresis)) || coolPred(hysteresis))) {
                logger.solar(`Solar ${heater.name} (${body.name}): the readings have moved since the start was turned down ${Math.round((nowMs - failed.at) / 60000)} min ago, so it is checked again before the check period is over: water ${Math.round(body.temp * 100) / 100} (expected ${Math.round(waterPred * 100) / 100} at the solar pump speed), solar ${Math.round(state.temps.solar * 10) / 10}.`);
                carried = { temp: Math.round(failed.water * 10) / 10, at: failed.at };
                rt.valveFailed.delete(heater.id);
                blockStart = false; holdWhy = ''; holdLeftMs = 0;
            }
        }
        // The valve delay (controller.solar.valveDelaySeconds): a start that looks worthwhile first runs the pump at its solar speed with the valve
        // relay off, is checked again with the readings taken at that speed, and only then is the valve relay switched on. The conditions above
        // are evaluated on every pass, so the second check is the same decision made with the pump at the speed solar runs at. It is made when the
        // delay is over and not during it: the water reading jumps for the first seconds after the pump speeds up (about 1.6 degrees on the author's
        // pool, where the pump draws from the main drain and the skimmer and probably takes a different mix of the two at a different speed), and a
        // start turned down on that jump was tried and turned down again every few minutes.
        let valveWait = false;
        // A start the check has decided on stands until the heater reports it is on. Switching the valve relay on takes a moment, and a pass made
        // in that moment sees the heater still off; with the water reading right at the setpoint it used to judge the start again, turn it down,
        // and switch solar off a fraction of a second after it came on.
        let committed: string = undefined;
        if (valveMs > 0) {
            const trial = rt.valveTrial.get(heater.id);
            const rd = (v: any) => typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : v;
            const rd2 = (v: any) => typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v;
            // The change since the pump sped up: what the speed-up does to the water and collector readings is what the valve delay exists to see.
            const chg = (from: any, to: any) => typeof from === 'number' && typeof to === 'number' && isFinite(from) && isFinite(to) ? `${to - from >= 0 ? '+' : ''}${Math.round((to - from) * 100) / 100}` : 'n/a';
            const lead = `water ${rd2(body.temp)}, solar ${rd(state.temps.solar)}, collector minus water ${rd(state.temps.solar - body.temp)} (run delta ${heater.stopTempDelta}, start delta ${heater.startTempDelta}), setpoint ${cfgBody.heatSetpoint}, cool setpoint ${cfgBody.coolSetpoint}, night ${state.heliotrope.isNight}`;
            if (hState.isOn) {
                rt.valveTrial.delete(heater.id);
                rt.valveFailed.delete(heater.id);
            }
            else if (!blockStart && (typeof trial !== 'undefined' || heatBegin || coolBegin || firstProbe)) {
                // Before the pump speeds up the start is judged by the start rules; once it is at its solar speed, by the rules above.
                const ok = typeof trial === 'undefined' ? (heatBegin || coolBegin) : (heatAtSpeed || coolAtSpeed);
                const t = typeof trial === 'undefined' ? { at: nowMs, bodyId: body.id, pass: rt.pass, done: false, water: body.temp, solar: state.temps.solar, noteAt: nowMs, shown: typeof carried !== 'undefined' ? { temp: carried.temp, at: carried.at, star: true } : rt.runReading.has(heater.id) ? { temp: Math.round(rt.runReading.get(heater.id).temp * 10) / 10, at: rt.runReading.get(heater.id).at, star: true } : { temp: Math.round(body.temp * 10) / 10, at: nowMs, star: false } } : trial;
                t.pass = rt.pass;
                if (typeof trial === 'undefined') {
                    rt.valveTrial.set(heater.id, t);
                    if (typeof pumpStartedAt === 'number') rt.firstCheck.set(heater.id, pumpStartedAt);
                    logger.solar(`Solar ${heater.name} (${body.name}): a start looks worthwhile ${(heatBegin || coolBegin) ? 'at the slow pump speed' : 'to check: this is the first check since the pump started, made because the collector is far enough ' + (state.temps.solar > waterPred ? 'above' : 'below') + ' the water (the water side is judged by the check)'}${speedOffset !== 0 ? ` (the water is expected to read ${Math.round(waterPred * 100) / 100} at the solar pump speed, ${speedOffset > 0 ? '+' : ''}${Math.round(speedOffset * 100) / 100} as at the last check)` : ''}, so the pump runs at its solar speed for ${Math.round(valveMs / 1000)} s with the valve relay off, then the start is checked again: ${lead}. The solar circuit turns on with it; the pump speed change follows in the log.`);
                }
                const leftMs = valveMs - (nowMs - t.at);
                const since = `water ${chg(t.water, body.temp)}, collector ${chg(t.solar, state.temps.solar)} since the pump sped up`;
                if (leftMs > 0) {
                    valveWait = true;
                    // The temperature shown does not follow the reading while the check is under way. It stays what it was: the reading at the solar pump
                    // speed from the check before, still marked, when that was being shown, and otherwise the reading from before the pump sped up. It
                    // changes when the check is over.
                    solarCheckTemp = t.shown.temp;
                    solarCheckTime = new Date(t.shown.at).toISOString();
                    solarChecking = t.shown.star ? undefined : true;
                    if (nowMs - t.noteAt >= 30000) logger.verbose(`Solar ${body.name}: valve delay check, ${Math.ceil(leftMs / 1000)} s left: the temperature shown is still ${solarCheckTemp}${t.shown.star ? '*' : ''}; the sensor reads ${Math.round(body.temp * 100) / 100} at the solar pump speed.`);
                    heatNote = `Solar check in ${Math.ceil(leftMs / 1000)} s (the pump runs at its solar speed first)`;
                    if (nowMs - t.noteAt >= 30000) {
                        t.noteAt = nowMs;
                        logger.solar(`Solar ${heater.name} (${body.name}): valve delay, ${Math.ceil(leftMs / 1000)} s left and ${ok ? 'still worthwhile' : 'not worthwhile on these readings (the start is judged when the delay is over)'} (${since}): ${lead}.`);
                    }
                }
                else if (ok || t.done) {
                    if (t.done) committed = t.cool === true ? 'cool' : 'heat';   // the valve relay is already being switched on
                    else {
                        t.done = true;
                        hState.solarSpeedOffset = (typeof t.water === 'number' && typeof body.temp === 'number' && isFinite(body.temp - t.water)) ? Math.round(Math.min(5, Math.max(-5, body.temp - t.water)) * 100) / 100 : hState.solarSpeedOffset;
                        t.cool = !heatAtSpeed && coolAtSpeed;
                        committed = t.cool === true ? 'cool' : 'heat';
                        const secs = Math.round((nowMs - t.at) / 1000);
                        logger.solar(`Solar ${heater.name} (${body.name}): still worthwhile after ${secs} s at the solar pump speed (${since}), so the valve relay is switched on: ${lead}; ${rt.valveTally(heater.id, 'started', secs)}.`);
                    }
                }
                else {
                    rt.valveTrial.delete(heater.id);
                    rt.valveFailed.set(heater.id, { at: nowMs, water: body.temp, heatSet: cfgBody.heatSetpoint, coolSet: cfgBody.coolSetpoint });
                    hState.solarSpeedOffset = (typeof t.water === 'number' && typeof body.temp === 'number' && isFinite(body.temp - t.water)) ? Math.round(Math.min(5, Math.max(-5, body.temp - t.water)) * 100) / 100 : hState.solarSpeedOffset;
                    rt.runReading.delete(heater.id);
                    solarCheckTemp = Math.round(body.temp * 10) / 10;
                    solarCheckTime = new Date(nowMs).toISOString();
                    const retryMs = Math.max(solarCheckPeriodMs(), settleMs, valveMs);
                    const secs = Math.round((nowMs - t.at) / 1000);
                    const why = (heater.coolingEnabled && coolTime) ? 'the readings at the solar pump speed no longer support heating or nocturnal cooling'
                        : !(waterTemp < (cfgBody.heatSetpoint + hysteresis)) ? `the water is at or above the level solar stops at, ${cfgBody.heatSetpoint + hysteresis} (the setpoint plus the hysteresis)`
                        : !(state.temps.solar > body.temp) ? 'the collector is not warmer than the water'
                        : !((state.temps.solar - body.temp) > heater.stopTempDelta) ? 'the collector lead fell to the run delta'
                        : 'the collector has not risen the start delta above where it was when solar last turned off';
                    logger.solar(`Solar ${heater.name} (${body.name}): not started: after ${secs} s at the solar pump speed ${why} (${since}): ${lead}. The pump returns to its normal speed and the start is checked again in ${Math.round(retryMs / 60000)} min (the solar check period), or at once if the setpoint is changed; ${rt.valveTally(heater.id, 'turnedDown', secs)}.`);
                }
            }
        }
        // A stop that has been decided stands until the heater reports it is off, as a start does. Switching the valve relay off takes a moment, and
        // the passes made in that moment see the heater still on; with the collector lead right at the run delta a new water reading used to
        // judge solar worth running again, which cleared the reheat guard the stop had just set and reported heating for an instant.
        const stopping = hState.isOn && rt.offNoted.has(heater.id);
        if (stopping) { }
        else if (((heatOk && direct) || committed === 'heat') && committed !== 'cool' && !blockStart && !valveWait) {
            isOn = true;
            body.heatStatus = sys.board.valueMaps.heatStatus.getValue('solar');
            isHeating = true;
        }
        else if (((!heatOk && coolOk && direct) || committed === 'cool') && !blockStart && !valveWait) {
            isOn = true;
            body.heatStatus = sys.board.valueMaps.heatStatus.getValue('cooling');
            isHeating = true;
            isCooling = true;
        }
        // A start that is pending holds back the heaters after solar in the list. Without the settle and valve delays solar would have
        // started at once, and a backup heater was never started for those minutes. A start the valve delay check turned down does not
        // hold them: the check period after it is time solar is not expected to run.
        if (!isOn && !stopping && (valveWait || typeof committed !== 'undefined' || (blockStart && !failedHold && (heatBegin || coolBegin)))) solarHolds = true;
        if (isOn) {
            // The heater reports on: this is a reading with solar running. (While it is still being switched on the reading is the check's.)
            if (hState.isOn) rt.runReading.set(heater.id, { temp: body.temp, at: nowMs });
        }
        else if (typeof solarCheckTemp === 'undefined') {
            const ran = rt.runReading.get(heater.id);
            if (typeof ran !== 'undefined') {
                if (nowMs - ran.at > Math.max(solarCheckPeriodMs(), settleMs, valveMs)) rt.runReading.delete(heater.id);
                else {
                    solarCheckTemp = Math.round(ran.temp * 10) / 10;
                    solarCheckTime = new Date(ran.at).toISOString();
                }
            }
        }
        // The return sensor: its reading whenever it has one, and its gain over the water going in while solar is running.
        {
            const ret = solarReturnTemp(body.temp);
            if (typeof ret !== 'undefined') {
                solarReturn = Math.round(ret * 10) / 10;
                if (isOn && hState.isOn) solarGain = Math.round((ret - body.temp) * 10) / 10;
            }
        }
        if (isOn) rt.offNoted.delete(heater.id);
        if (isOn && !hState.isOn) hState.targetStop = undefined;
        if (!isOn) rt.startWatch.delete(heater.id);
        else {
            let w = rt.startWatch.get(heater.id);
            if (typeof w === 'undefined' && !hState.isOn) {
                w = { at: nowMs, water: body.temp, solar: state.temps.solar, noteAt: nowMs };
                rt.startWatch.set(heater.id, w);
                logger.verbose(`Solar ${heater.name} (${body.name}): turning on with water ${Math.round(body.temp * 100) / 100}, collector ${Math.round(state.temps.solar * 10) / 10}; the readings follow every 30 s for ${SOLAR_START_WATCH_MS / 60000} minutes.`);
            }
            else if (typeof w !== 'undefined' && nowMs - w.at <= SOLAR_START_WATCH_MS && nowMs - w.noteAt >= 30000) {
                w.noteAt = nowMs;
                const d = (from: number, to: number) => `${to - from >= 0 ? '+' : ''}${Math.round((to - from) * 100) / 100}`;
                logger.verbose(`Solar ${heater.name} (${body.name}): ${Math.round((nowMs - w.at) / 1000)} s after turning on: water ${Math.round(body.temp * 100) / 100} (${d(w.water, body.temp)}), collector ${Math.round(state.temps.solar * 10) / 10} (${d(w.solar, state.temps.solar)})${typeof solarReturn !== 'undefined' ? `, return ${solarReturn} (${solarReturn - body.temp >= 0 ? '+' : ''}${Math.round((solarReturn - body.temp) * 10) / 10} over the water)` : ''}.`);
            }
        }
        // While solar runs, its readings go in the solar log every five minutes: the water, the collector and its lead over the water, and when a
        // return sensor is reading, the return and its gain over the water (the heat the run delivers). The first line comes five minutes after the
        // start, which is logged with the same readings, as is the stop.
        if (!(isOn && hState.isOn)) rt.runLogAt.delete(heater.id);
        else {
            const lastAt = rt.runLogAt.get(heater.id);
            if (typeof lastAt === 'undefined') rt.runLogAt.set(heater.id, nowMs);
            else if (nowMs - lastAt >= SOLAR_RUN_LOG_MS) {
                rt.runLogAt.set(heater.id, nowMs);
                logger.solar(`Solar ${heater.name} ${isCooling ? 'cooling' : 'heating'} (${body.name}): ${this.runReadings(body)}.`);
            }
        }
        if (hstate.isOn && !isOn) {
            // The reheat guard is for a stop the collector caused (flow cooled it, a cloud, the evening): it must climb again before the next start.
            // When the water reached its target the collector was fine, so there is nothing to wait for and no guard is set.
            const solarT = state.temps.solar;
            const collectorStop = hState.isCooling
                ? (coolTime && (!(solarT < waterTemp) || !((waterTemp - solarT) > heater.stopTempDelta)))
                : (!(solarT > waterTemp) || !((solarT - waterTemp) > heater.stopTempDelta));
            const firstOffPass = !rt.offNoted.has(heater.id);
            if (firstOffPass) hState.prevHeaterOffTemp = collectorStop ? solarT : undefined;
            if (firstOffPass) { if (collectorStop) rt.guardAt.set(heater.id, nowMs); else rt.guardAt.delete(heater.id); }
            // A stop because the water stayed past the stop level waits for the hysteresis on the other side before the next start.
            if (firstOffPass) hState.targetStop = (!collectorStop && stopNow) ? (hState.isCooling ? 'cooling' : 'heating') : undefined;
            const restartAt = hState.isCooling ? (coolPoint + hysteresis) : (cfgBody.heatSetpoint - hysteresis);
            rt.offNoted.add(heater.id);
            if (firstOffPass && typeof solarReturn !== 'undefined') logger.solar(`Solar ${heater.name} (${body.name}): as it turned off the return read ${solarReturn}, ${Math.abs(Math.round((solarReturn - body.temp) * 10) / 10)} ${solarReturn - body.temp >= 0 ? 'above' : 'below'} the water at ${Math.round(body.temp * 100) / 100}.`);
            if (logger.solarExplain && firstOffPass) logger.solar(`Solar ${heater.name} (${body.name}) turned off because ${collectorStop ? 'the collector lead over the water fell to the run delta ' + heater.stopTempDelta + ' (reheat guard set: the collector must rise ' + heater.startTempDelta + ' above ' + (Math.round(solarT * 10) / 10) + ')' : 'the water was ' + (hState.isCooling ? 'at or below ' : 'at or above ') + stopAt + (stopFar ? ' by ' + Math.max(hysteresis, 1) + ' or more, so there was no wait' : ' for ' + Math.round(settleMs / 1000) + ' s') + ' (no reheat guard set; solar restarts when the water is ' + (hState.isCooling ? 'above ' : 'below ') + restartAt + ')'}.`);
        } // 6  
        // With log.solar.explain on, the readings while a settle delay is holding the decision, once a minute, and when it ends.
        {
            const r1 = (v: any) => typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : v;
            const r2 = (v: any) => typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v;
            const held = blockStart || waitStop;
                    // A wait is shown only when a start is called for once it is over; otherwise the reason solar is off is the note (below).
                    if (blockStart && (heatBegin || coolBegin)) heatNote = `Solar waiting to start: ${Math.ceil(holdLeftMs / 60000)} min left ${holdWhy}`;
                    else if (waitStop) heatNote = `Solar stops in ${Math.ceil(holdLeftMs / 60000)} min if the water stays ${hState.isCooling ? 'at or below' : 'at or above'} ${stopAt}`;
            const prevNote = rt.settleLog.get(heater.id);
            const readings = `water ${r2(body.temp)}, solar ${r1(state.temps.solar)}, collector minus water ${r1(state.temps.solar - body.temp)} (run delta ${heater.stopTempDelta}, start delta ${heater.startTempDelta}), setpoint ${cfgBody.heatSetpoint}, cool setpoint ${cfgBody.coolSetpoint}, hysteresis ${hysteresis}, night ${state.heliotrope.isNight}`;
            if (held) {
                if (logger.solarExplain && (typeof prevNote === 'undefined' || prevNote.key !== holdWhy || nowMs - prevNote.at >= 60000)) {
                    rt.settleLog.set(heater.id, { key: holdWhy, at: nowMs });
                    logger.solar(`Solar ${heater.name} (${body.name}) settle delay ${holdWhy}, ${Math.ceil(holdLeftMs / 1000)} s left of ${Math.round(holdTotalMs / 1000)} s: ${readings}; without the delay solar would be ${(blockStart && (heatBegin || coolBegin)) ? 'on' : 'off'}.`);
                }
            }
            else if (typeof prevNote !== 'undefined') {
                rt.settleLog.delete(heater.id);
                if (logger.solarExplain) logger.solar(`Solar ${heater.name} (${body.name}) settle delay ${prevNote.key} ended: ${readings}; solar is ${isOn ? 'on' : 'off'}.`);
            }
        }
        // While solar heating or nocturnal cooling is enabled and wanted (the water is below the setpoint, or above the cool setpoint)
        // but the decision is not to run, say why, so a long wait can be followed. It is logged when the reason changes and then every
        // 15 minutes, not on every status pass. It is logged only when log.solar.explain is on in config.json; the short note for the dashboard is always set.
        {
            const r1 = (v: any) => typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : v;
            if (isOn) rt.whyNot.delete(heater.id);
            else {
                const waterT = body.temp;
                const solarT = state.temps.solar;
                const prevOff = hState.prevHeaterOffTemp;
                const night = coolTime;
                let key = '', why = '', kind = 'heating', repeat = true;
                if (waterT < cfgBody.heatSetpoint) {
                    if (hState.targetStop === 'heating' && !(waterT < (cfgBody.heatSetpoint - hysteresis))) { key = 'hysteresis'; why = `solar stopped at its target and restarts only when the water (${r1(waterT)}) is below ${cfgBody.heatSetpoint - hysteresis}: the setpoint ${cfgBody.heatSetpoint} minus the ${hysteresis} degree hysteresis`; }
                    else if (!(solarT > waterT)) { key = 'collector-not-warmer'; why = `the collector (${r1(solarT)}) is not warmer than the water (${r1(waterT)})`; }
                    else if (!((solarT - waterT) > heater.stopTempDelta)) { key = 'run-delta'; why = `the collector is only ${r1(solarT - waterT)} above the water and needs to be more than ${heater.stopTempDelta} (the run delta)`; }
                    else if (typeof prevOff !== 'undefined' && !((solarT - prevOff) > heater.startTempDelta)) { key = 'reheat'; why = `the collector (${r1(solarT)}) has only risen ${r1(solarT - prevOff)} above where it was when solar last turned off (${r1(prevOff)}); it must rise more than ${heater.startTempDelta} (the start delta), to above ${r1(prevOff + heater.startTempDelta)}`; }
                    else if (!hState.isOn && !heatBegin && !(waterPred < (cfgBody.heatSetpoint + hysteresis))) { key = 'at-speed-water'; why = `at the solar pump speed the water is expected to read ${r1(waterPred)} (${speedOffset > 0 ? '+' : ''}${r1(speedOffset)} as at the last check), which is not below ${cfgBody.heatSetpoint + hysteresis}, the level solar stops at (the setpoint plus the hysteresis)`; }
                    else if (!hState.isOn && !heatBegin) { key = 'at-speed'; why = `at the solar pump speed the water is expected to read ${r1(waterPred)} (${speedOffset > 0 ? '+' : ''}${r1(speedOffset)} as at the last check), and with that the collector (${r1(solarT)}) is not more than ${heater.stopTempDelta} above it`; }
                }
                // At night a collector that cannot heat is the ordinary state of things. When nocturnal cooling is enabled and the water is above the cool
                // setpoint, cooling is what is being waited for, so that is what is explained (the water can be below the heat setpoint at the same time).
                const coolWanted = heater.coolingEnabled && waterT > cfgBody.coolSetpoint;
                if (coolWanted && (!(waterT < cfgBody.heatSetpoint) || (night && (key === 'collector-not-warmer' || key === 'run-delta')))) {
                    kind = 'nocturnal cooling'; key = ''; why = '';
                    if (!night) { key = 'cool-daytime'; why = 'it is daytime (nocturnal cooling runs only at night)'; }
                    else if (!(waterT > coolPoint)) { key = 'cool-backup'; why = `the water (${r1(waterT)}) is not above ${r1(coolPoint)}: ${backupName} can heat in this mode, to ${r1(backupTop)}, so cooling works to no lower than that plus the ${hysteresis} degree hysteresis, above the Cool Point ${cfgBody.coolSetpoint}, and the two do not take turns`; }
                    else if (!(solarT < waterT)) { key = 'cool-collector-not-cooler'; why = `the collector (${r1(solarT)}) is not cooler than the water (${r1(waterT)})`; }
                    else if (!((waterT - solarT) > heater.stopTempDelta)) { key = 'cool-run-delta'; why = `the water is only ${r1(waterT - solarT)} warmer than the collector and needs to be more than ${heater.stopTempDelta} (the run delta)`; }
                    else if (hState.targetStop === 'cooling' && !(waterT > (coolPoint + hysteresis))) { key = 'cool-hysteresis'; why = `cooling stopped at its target and restarts only when the water (${r1(waterT)}) is above ${r1(coolPoint + hysteresis)}: the ${coolPoint === cfgBody.coolSetpoint ? 'cool setpoint' : 'level cooling works to (kept clear of ' + backupName + ')'} plus the ${hysteresis} degree hysteresis`; }
                    else if (typeof prevOff !== 'undefined' && !((prevOff - solarT) > heater.startTempDelta)) { key = 'cool-reheat'; why = `the collector (${r1(solarT)}) has only dropped ${r1(prevOff - solarT)} below where it was when solar last turned off (${r1(prevOff)}); it must drop more than ${heater.startTempDelta} (the start delta), to below ${r1(prevOff - heater.startTempDelta)}`; }
                }
                else if (!(waterT < cfgBody.heatSetpoint)) { key = 'at-target'; repeat = false; kind = 'heating'; why = `the water (${r1(waterT)}) is not below the setpoint ${cfgBody.heatSetpoint}${heater.coolingEnabled ? ' and not above the cool setpoint ' + cfgBody.coolSetpoint : ''}`; }
                if (key !== '' && typeof heatNote === 'undefined') {
                    // A hold above (a delay, a stop wait) takes precedence; these are the waits worth showing.
                    if (key === 'hysteresis') heatNote = `Solar waiting: the water must fall below ${cfgBody.heatSetpoint - hysteresis} to restart`;
                    else if (key === 'reheat') heatNote = `Solar waiting: the collector must reach ${r1(prevOff + heater.startTempDelta)} (now ${r1(solarT)})`;
                    else if (key === 'at-speed') heatNote = `Solar waiting: the collector needs to be more than ${r1(heater.stopTempDelta + startMargin + speedOffset)} above the water (${heater.stopTempDelta + startMargin} at the solar pump speed, where the water reads ${r1(speedOffset)} higher)`;
                    else if (key === 'at-speed-water') heatNote = `Solar waiting: at the solar pump speed the water reads about ${r1(waterPred)}, not below ${cfgBody.heatSetpoint + hysteresis} where solar stops`;
                    else if (key === 'at-target') heatNote = `Solar waiting: the water (${r1(body.temp)}) is ${r1(body.temp) > cfgBody.heatSetpoint ? 'above' : 'at'} the setpoint ${cfgBody.heatSetpoint}`;
                    else if (key === 'run-delta') heatNote = `Solar waiting: the collector needs to be more than ${heater.stopTempDelta} above the water`;
                    else if (key === 'collector-not-warmer') heatNote = 'Solar waiting: the collector is not warmer than the water';
                    else if (key === 'cool-run-delta') heatNote = `Cooling waiting: the water needs to be more than ${heater.stopTempDelta} above the collector`;
                    else if (key === 'cool-collector-not-cooler') heatNote = 'Cooling waiting: the collector is not cooler than the water';
                    else if (key === 'cool-hysteresis') heatNote = `Cooling waiting: the water must rise above ${r1(coolPoint + hysteresis)} to restart`;
                    else if (key === 'cool-backup') heatNote = `Cooling waiting: the water must be above ${r1(coolPoint)} (${backupName} heats to ${r1(backupTop)})`;
                    else if (key === 'cool-reheat') heatNote = `Cooling waiting: the collector must fall below ${r1(prevOff - heater.startTempDelta)} (now ${r1(solarT)})`;
                }
                if (key !== '') {
                    const last = rt.whyNot.get(heater.id);
                    const now = new Date().getTime();
                    // A changed reason is logged once it has held for two minutes, so a reading hovering on a threshold does not log a pair of lines every
                    // pass or two. The same reason is repeated every 15 minutes while it holds.
                    let logIt = typeof last === 'undefined';
                    if (!logIt && last.key !== key) {
                        const pend = rt.whyNotPending.get(heater.id);
                        if (typeof pend === 'undefined' || pend.key !== key) rt.whyNotPending.set(heater.id, { key: key, since: now });
                        else if (now - pend.since >= 2 * 60 * 1000) logIt = true;
                    }
                    else if (!logIt) {
                        rt.whyNotPending.delete(heater.id);
                        if (repeat && now - last.at >= 15 * 60 * 1000) logIt = true;
                    }
                    if (logger.solarExplain && logIt) {
                        rt.whyNot.set(heater.id, { key: key, at: now });
                        rt.whyNotPending.delete(heater.id);
                        logger.solar(`Solar ${heater.name} (${body.name}, mode ${mode}) is not ${kind}: ${why}. Water ${r1(body.temp)}, solar ${r1(solarT)}, setpoint ${cfgBody.heatSetpoint}, cool setpoint ${cfgBody.coolSetpoint}, start/run delta ${heater.startTempDelta}/${heater.stopTempDelta}, night ${night}.`);
                    }
                }
            }
        }
        // Note each change of the solar decision with the readings behind it (see the 'warn-solar' log level). Only a change
        // is logged, so this does not repeat on every status pass.
        {
            const solarNow = isOn ? (isCooling ? 'cooling' : 'heating') : 'off';
            if (rt.logged.get(heater.id) !== solarNow) {
                rt.logged.set(heater.id, solarNow);
                const r2 = (v: any) => typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v;
                const r1 = (v: any) => typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : v;
                const prevOff = hState.prevHeaterOffTemp;
                logger.solar(`Solar ${heater.name} ${solarNow} (${body.name}, mode ${mode}): water ${r2(body.temp)}, setpoint ${cfgBody.heatSetpoint}, cool setpoint ${cfgBody.coolSetpoint}, solar ${r1(state.temps.solar)}, collector minus water ${r1(state.temps.solar - body.temp)} (run delta ${heater.stopTempDelta}), collector at last off ${typeof prevOff === 'undefined' ? 'n/a' : r1(prevOff)}, collector minus last off ${typeof prevOff === 'undefined' ? 'n/a' : r1(state.temps.solar - prevOff)} (start delta ${heater.startTempDelta}), night ${state.heliotrope.isNight}${this.returnReadings(body)}`);
            }
        }
        return { isOn, isHeating, isCooling, heatNote, solarCheckTemp, solarCheckTime, solarChecking, solarReturn, solarGain, holdsOthers: solarHolds };
    }
    // The return and its difference from the water, for a log line: empty when there is no return sensor or it is not reading.
    private returnReadings(body: BodyTempState): string {
        const ret = solarReturnTemp(body.temp);
        if (typeof ret === 'undefined') return '';
        const r2 = (v: number) => Math.round(v * 100) / 100;
        const gain = r2(ret - body.temp);
        return `, return ${r2(ret)}, return minus water ${gain >= 0 ? '+' : ''}${gain}`;
    }
    // The readings logged while solar runs.
    private runReadings(body: BodyTempState): string {
        const r1 = (v: any) => typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : v;
        const r2 = (v: any) => typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v;
        return `water ${r2(body.temp)}, solar ${r1(state.temps.solar)}, collector minus water ${r1(state.temps.solar - body.temp)}${this.returnReadings(body)}`;
    }
}
export const solar = new SolarDecision();
