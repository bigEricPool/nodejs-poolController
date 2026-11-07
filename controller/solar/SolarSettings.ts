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
// The readers of the solar settings in the controller.solar section of config.json.
import { config } from '../../config/Config';
import { sys } from '../Equipment';
import { state } from '../State';

// controller.solar.settleMinutes in config.json (default 5; 0 turns the delay off): how long the solar decision waits for the water and collector
// readings to settle. Solar is not started that long after the body's pump starts or after solar turns off, and the water must stay past the
// stop level that long before solar stops for it.
function solarSettleMs(): number {
    let mins = 5;
    try {
        const c = config.getSection('controller.solar');
        if (typeof c.settleMinutes !== 'undefined') { const v = parseFloat(c.settleMinutes); if (isFinite(v) && v >= 0) mins = v; }
    } catch (err) { /* the default applies */ }
    return mins * 60000;
}
// controller.solar.hysteresis in config.json (default 0.5, 0 turns it off): the band around the target the water must cross before solar changes state.
// Half a degree suits a water reading that is steady to a few tenths. A whole degree is the value to try when solar still switches off and on around
// the setpoint, when the reading moves more than half a degree as the pump changes speed and the valve delay is not used, or when the sensor reports
// whole degrees.
// Solar stops when the water is that many degrees past the target (above the setpoint when heating) for the whole settle delay, and after a stop at
// the target it starts again only when the water is that many degrees back the other side, so it does not cycle on and off around the setpoint.
function solarHysteresis(): number {
    let deg = 0.5;
    try {
        const c = config.getSection('controller.solar');
        if (typeof c.hysteresis !== 'undefined') { const v = parseFloat(c.hysteresis); if (isFinite(v) && v >= 0) deg = v; }
    } catch (err) { /* the default applies */ }
    return deg;
}
// controller.solar.valveDelaySeconds in config.json (default 0, which turns it off; 120 is a value to start with): when solar should start, the body's pump first runs at its solar speed
// (the virtual solar circuit is turned on, so a pump speed tied to it applies) for this long with the valve relay still off, and the start is checked again
// with the readings taken at that speed. The water reading runs high while the pump is faster (warm water standing in the pipes), so a start that was
// worthwhile at the slow speed may not be at the speed solar runs at. Only if it still is does the valve relay turn on.
// The delay is there so that solar works properly when the water reading changes simply because the flow rate changed in the section of the
// plumbing where the temperature is sensed. It is configurable because how big that change is, and how long it takes to settle, depends on the
// plumbing: where the sensor sits, and what the pump draws from (a main drain and a skimmer can supply a different mix at a different speed).
function solarValveDelayMs(): number {
    let secs = 0;
    try {
        const c = config.getSection('controller.solar');
        if (typeof c.valveDelaySeconds !== 'undefined') { const v = parseFloat(c.valveDelaySeconds); if (isFinite(v) && v >= 0) secs = v; }
    } catch (err) { /* the default applies */ }
    return secs * 1000;
}
// controller.solar.returnSensor in config.json ('' by default; 'solarSensor2', 'solarSensor3' or 'solarSensor4'): the temperature input that sits on
// the pipe coming back from the solar collector. The collector sensor is usually in the air beside the panels; the return sensor reads what solar
// is actually delivering. For now it is shown and logged, with its gain over the water going in, and takes no part in the decision.
// It is offered only where there is one body: with more, solar sensors 2 to 4 are the collector sensors of the other bodies.
const SOLAR_RETURN_SENSORS = ['solarSensor2', 'solarSensor3', 'solarSensor4'];
function solarReturnSensor(): string {
    if (sys.equipment.maxBodies > 1) return undefined;
    try {
        const slot = config.getSection('controller.solar').returnSensor;
        return SOLAR_RETURN_SENSORS.indexOf(slot) >= 0 ? slot : undefined;
    } catch (err) { return undefined; }
}
// The return reading, or undefined when there is no return sensor or it is not reading: nothing has arrived, the value is exactly 0 (an input with
// nothing converting it), or it is further from the water than any collector could put it (an input with no probe on it).
function solarReturnTemp(waterTemp: number): number {
    const slot = solarReturnSensor();
    if (typeof slot === 'undefined') return undefined;
    const v = state.temps[slot];
    if (typeof v !== 'number' || !isFinite(v) || v === 0) return undefined;
    const far = sys.board.valueMaps.tempUnits.getName(state.temps.units) === 'C' ? 35 : 60;
    if (typeof waterTemp === 'number' && isFinite(waterTemp) && Math.abs(v - waterTemp) > far) return undefined;
    return v;
}
// controller.solar.checkPeriodMinutes in config.json (default 60): the solar check period. After the valve delay check turns a start down, the start
// is not checked again for this long (and never sooner than the settle delay or the valve delay): there is no need to speed the pump up to test the
// water more often than that. A change of setpoint is checked at once.
function solarCheckPeriodMs(): number {
    let mins = 60;
    try {
        const c = config.getSection('controller.solar');
        if (typeof c.checkPeriodMinutes !== 'undefined') { const v = parseFloat(c.checkPeriodMinutes); if (isFinite(v) && v >= 0) mins = v; }
    } catch (err) { /* the default applies */ }
    return mins * 60000;
}
// controller.solar.startMargin in config.json (default 2, 0 to 10 degrees): a valve delay check begins, and passes, only when the collector leads
// the water by more than the run delta plus this. A check that passed with the lead right at the run delta was undone by the next reading (on
// 20 October 2026 the valve opened and closed in the same second), and runs started on a small lead stopped again within minutes.
function solarStartMargin(): number {
    let deg = 2;
    try {
        const c = config.getSection('controller.solar');
        if (typeof c.startMargin !== 'undefined') { const v = parseFloat(c.startMargin); if (isFinite(v) && v >= 0) deg = Math.min(v, 10); }
    } catch (err) { /* the default applies */ }
    return deg;
}
// controller.solar.coolAnyTime in config.json (default false): nocturnal cooling may run at any hour, not only between sunset and sunrise. Meant for
// testing the cooling paths that the night cannot reach (a cooling run stopped by a collector warming in the morning sun, and heating starting after
// it); with it on, cooling also runs on a cool or cloudy day whenever its rules pass. Heating and the reheat guard clearing at sunset are unchanged.
function solarCoolAnyTime(): boolean {
    try {
        const c = config.getSection('controller.solar');
        return c.coolAnyTime === true || c.coolAnyTime === 'true';
    } catch (err) { return false; }
}
// controller.solar.minRunMinutes in config.json (default 5, 0 to 60): for this long after solar turns on it is not stopped because the collector's
// lead fell to the run delta. The collector reading falls from its idle temperature as water starts to flow, and runs ended within minutes. A
// collector that falls to or below the water still stops solar at once, and so does the water reaching its stop level.
function solarMinRunMs(): number {
    let mins = 5;
    try {
        const c = config.getSection('controller.solar');
        if (typeof c.minRunMinutes !== 'undefined') { const v = parseFloat(c.minRunMinutes); if (isFinite(v) && v >= 0) mins = Math.min(v, 60); }
    } catch (err) { /* the default applies */ }
    return mins * 60000;
}
export { solarSettleMs, solarHysteresis, solarValveDelayMs, SOLAR_RETURN_SENSORS, solarReturnSensor, solarReturnTemp, solarCheckPeriodMs, solarStartMargin, solarCoolAnyTime, solarMinRunMs };
