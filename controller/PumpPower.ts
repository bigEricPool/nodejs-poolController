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

// How much electricity a relay driven pump uses. A pump on relays reports no power, so this keeps the time it spends at each speed and works
// the energy out from the watts set for that speed: the time is exact, the energy is as good as the watts entered. The settings are in the
// `pumpPower` section of config.json, and it does nothing until that section is enabled and has a pump with speeds:
//   enabled       whether the time is being kept
//   ratePerKwh    the price of a kWh, 0 to show no cost
//   keepDays      how long the log is kept
//   pumps         one entry per pump: { pump (its id), speeds: [{ id, name, rpm, watts, priority, connectionId, deviceBinding }] }
//
// A pump whose relays each pick a speed (single speed, two speed, SuperFlo) keeps its speeds on its own relays instead: speedName, rpm,
// watts and priority on each relay in poolConfig.json, set on the pump page. Once any relay of such a pump has watts its relays are its
// speeds, the speed id being the relay id, and its entry in `pumps` is not used. Each relay is one speed; when several relays are on, the
// priority picks the speed, so a two speed pump with both relays on counts as the speed with the better priority. The entries in `pumps`
// that line up with the pump's relays (every speed bound to a relay of that pump with the same id) are moved onto the relays that have no
// speed yet, the first time the tracking runs (see `copySpeedsToPumps`), so the log keeps its speed ids; nothing a relay already has is
// overwritten, and the entry is then removed from `pumps`. A pump is counted unless `trackPower` is turned off on it
// (the pump page); `enabled` above turns the whole tracking on or off.
//
// The SuperFlo type with one speed per relay also fits relay-selected variable speed pumps such as the Calimar / Black & Decker VSP with
// its automation controller add-on (three relays, one for each preset speed; tested on a Calimar 3 HP: Low, High and Medium, with Medium
// winning when two are on).
//
// The connection and device of a speed name the relay that selects it, the same two values a pump relay or a circuit is bound with. A speed
// without them is the pump's default speed: it counts whenever the pump is on and no other speed applies. When several speeds apply the one
// with the best priority is taken: 1 is first, 0 is not set and comes after any that are, and speeds that tie go by the most watts. It is a
// setting because the pump decides which input wins, and that need not be the fastest. The relay is not asked for its state, because a request to the
// relay manager makes it read the whole board. What njsPC already knows is used instead: a relay of the pump is on when its bit is set in the
// pump state, and any other relay is on when the circuit bound to it is on. A relay that neither uses is never seen as on (see `relaySource`).
//
// The log is data/pumpPowerLog.jsonl next to poolConfig.json. Each line is { t: start of the hour (ms), p: the pump id, s: { [speed id]: seconds
// in the hour }, off: seconds off } and speed id 0 is the pump running with no speed that applies. Lines hold seconds and not kWh so that a
// corrected watts figure or rate applies to the whole record. A line is added every 15 minutes, so several lines can have the same hour: add
// them. Time is credited as it passes between samples, so a gap in the samples (njsPC stopped) counts as nothing, which is right for a pump on
// latched relays since it stops when njsPC does.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { sys } from './Equipment';
import { state } from './State';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const SAMPLE_MS = 10000;
const MAX_CREDIT_MS = 15000;        // the most one sample can credit: a longer gap means nothing was watching
const FLUSH_MS = 15 * 60000;
const MAX_SPEEDS = 8;

export interface PumpPowerSpeed { id: number; name: string; rpm: number; watts: number; priority: number; connectionId: string; deviceBinding: string; }
export interface PumpPowerPump { pump: number; speeds: PumpPowerSpeed[]; }
export interface PumpPowerSettings { enabled: boolean; ratePerKwh: number; keepDays: number; pumps: PumpPowerPump[]; }
export type PumpPowerRange = 'day' | 'week' | 'month' | 'year';

type Seconds = { [key: string]: number };           // seconds by speed id, with `off`
type HourRow = { [pump: string]: Seconds };         // by pump id

// What the settings say once everything missing or out of range has its default.
export function normalizePumpPowerSettings(raw: any): PumpPowerSettings {
    const r = raw || {};
    const num = (v: any, min: number, max: number, def: number) => { const n = parseFloat(v); return isFinite(n) && n >= min && n <= max ? n : def; };
    const pumps: PumpPowerPump[] = [];
    for (const p of Array.isArray(r.pumps) ? r.pumps : []) {
        const id = parseInt(p && p.pump, 10);
        if (!(id > 0)) continue;
        const speeds: PumpPowerSpeed[] = [];
        for (const s of Array.isArray(p.speeds) ? p.speeds : []) {
            const sid = parseInt(s && s.id, 10);
            if (!(sid > 0)) continue;
            speeds.push({
                id: sid, name: typeof s.name === 'string' ? s.name.trim() : '', rpm: num(s.rpm, 0, 10000, 0), watts: num(s.watts, 0, 20000, 0), priority: Math.round(num(s.priority, 0, MAX_SPEEDS, 0)),
                connectionId: s.connectionId || '', deviceBinding: s.deviceBinding || ''
            });
        }
        pumps.push({ pump: id, speeds: speeds });
    }
    return { enabled: r.enabled === true || r.enabled === 'true', ratePerKwh: num(r.ratePerKwh, 0, 10, 0), keepDays: num(r.keepDays, 1, 2000, 400), pumps: pumps };
}
// Why a set of settings cannot be saved, or undefined when it can.
export function pumpPowerSettingsError(c: PumpPowerSettings): string | undefined {
    const seen: number[] = [];
    for (const p of c.pumps) {
        if (seen.indexOf(p.pump) >= 0) return `Pump ${p.pump} is listed twice`;
        seen.push(p.pump);
        if (p.speeds.length > MAX_SPEEDS) return `A pump can have at most ${MAX_SPEEDS} speeds`;
        const ids: number[] = [];
        let unbound = 0;
        for (const s of p.speeds) {
            if (ids.indexOf(s.id) >= 0) return `Speed id ${s.id} is used twice on pump ${p.pump}`;
            ids.push(s.id);
            if (!s.name) return `Every speed needs a name`;
            if (!(s.watts > 0)) return `Speed ${s.name} needs its watts`;
            if (!s.connectionId !== !s.deviceBinding) return `Speed ${s.name} needs both a connection and a device, or neither`;
            if (!s.connectionId) unbound++;
        }
        if (unbound > 1) return `Only one speed can have no relay: it is the default speed`;
    }
    return undefined;
}
// Whether speed a takes over from speed b when both apply.
function speedWins(a: PumpPowerSpeed, b: PumpPowerSpeed): boolean {
    if (a.priority !== b.priority) return a.priority > 0 && (b.priority === 0 || a.priority < b.priority);
    return a.watts > b.watts;
}
// The speed a pump is at: its id, 0 when it is on but no speed applies, or -1 when it is off.
export function pumpSpeedNow(speeds: PumpPowerSpeed[], pumpOn: boolean, relayOn: (s: PumpPowerSpeed) => boolean): number {
    let best: PumpPowerSpeed;
    for (const s of speeds) {
        const on = s.connectionId && s.deviceBinding ? relayOn(s) : pumpOn;
        if (on && (!best || speedWins(s, best))) best = s;
    }
    if (best) return best.id;
    return pumpOn ? 0 : -1;
}
function relayMatches(o: any, s: PumpPowerSpeed): boolean { return !!o && o.connectionId === s.connectionId && o.deviceBinding === s.deviceBinding; }
// Which of njsPC's records shows the speed's relay: 'pump', 'circuit', 'none', or 'default' for a speed that has no relay.
function relaySource(pumpId: number, s: PumpPowerSpeed): string {
    if (!s.connectionId || !s.deviceBinding) return 'default';
    if (sys.pumps.getItemById(pumpId).relays.get().some(r => relayMatches(r, s))) return 'pump';
    return sys.circuits.get().some(c => relayMatches(c, s)) ? 'circuit' : 'none';
}
function isRelayOn(pumpId: number, s: PumpPowerSpeed): boolean {
    const bits = state.pumps.getItemById(pumpId).relay || 0;
    const relays: any[] = sys.pumps.getItemById(pumpId).relays.get();
    for (let i = 0; i < relays.length; i++) {
        if (relayMatches(relays[i], s)) return ((bits >> ((relays[i].id || i + 1) - 1)) & 1) === 1;
    }
    return sys.circuits.get().some(c => relayMatches(c, s) && state.circuits.getItemById(c.id).isOn);
}
// The pump types whose relays each pick one speed. A Hayward relay pump's relays are the bits of a step number, so they are not speeds.
const RELAY_SPEED_TYPES = ['ss', 'ds', 'sf'];
export function hasRelaySpeeds(pump: any): boolean {
    return typeof pump !== 'undefined' && RELAY_SPEED_TYPES.indexOf(sys.board.valueMaps.pumpTypes.getName(pump.type)) >= 0;
}
// The speeds set on a pump's relays, or none when no relay of the pump has watts. A relay counts as a speed once it is bound and has
// watts; one with no speed name is named for its relay (Low Speed and High Speed on a two speed pump), so no speed is shown blank.
export function pumpRelaySpeeds(pumpId: number): PumpPowerSpeed[] {
    const pump = sys.pumps.find(p => p.id === pumpId);
    if (!hasRelaySpeeds(pump)) return [];
    const type = sys.board.valueMaps.pumpTypes.transform(pump.type) || {};
    const num = (v: any, max: number) => { const n = parseFloat(v); return isFinite(n) && n >= 0 && n <= max ? n : 0; };
    const speeds: PumpPowerSpeed[] = [];
    const relays = pump.relays.toArray();
    for (let i = 0; i < relays.length && speeds.length < MAX_SPEEDS; i++) {
        const r = relays[i];
        const id = r.id || i + 1;
        const watts = num(r.watts, 20000);
        if (!(watts > 0) || !r.connectionId || !r.deviceBinding) continue;
        const typeRelay = Array.isArray(type.relays) ? type.relays.find((x: any) => x.id === id) : undefined;
        const name = typeof r.speedName === 'string' && r.speedName.trim() ? r.speedName.trim()
            : type.maxRelays === 2 ? (id === 1 ? 'Low Speed' : 'High Speed') : typeRelay ? typeRelay.name : `Relay ${id}`;
        speeds.push({ id: id, name: name, rpm: num(r.rpm, 10000), watts: watts, priority: Math.round(num(r.priority, MAX_SPEEDS)), connectionId: r.connectionId, deviceBinding: r.deviceBinding });
    }
    return speeds;
}
// Whether the pump is counted: it is unless tracking is turned off on the pump. A pump that is not set up is left to the settings.
export function pumpTracked(pumpId: number): boolean {
    const pump = sys.pumps.find(p => p.id === pumpId);
    return typeof pump === 'undefined' || pump.trackPower !== false;
}
// The settings with each pump's speeds taken from its relays where they are set there, without the pumps not counted.
export function effectivePumpPowerSettings(c: PumpPowerSettings): PumpPowerSettings {
    const pumps: PumpPowerPump[] = [];
    const ids: number[] = [];
    for (const p of c.pumps) {
        ids.push(p.pump);
        if (!pumpTracked(p.pump)) continue;
        const onPump = pumpRelaySpeeds(p.pump);
        pumps.push({ pump: p.pump, speeds: onPump.length > 0 ? onPump : p.speeds });
    }
    for (const pump of sys.pumps.toArray()) {
        if (ids.indexOf(pump.id) >= 0 || pump.trackPower === false) continue;
        const onPump = pumpRelaySpeeds(pump.id);
        if (onPump.length > 0) pumps.push({ pump: pump.id, speeds: onPump });
    }
    return { ...c, pumps: pumps };
}
function addSeconds(to: Seconds, from: Seconds) {
    for (const k of Object.keys(from)) to[k] = (to[k] || 0) + from[k];
}

// One hour of one pump for other modules: `t` the start of the hour (ms), the seconds at each speed
// (by speed id; 0 is the pump on with no speed that applies), the seconds on in all, and the seconds off.
export interface PumpHour { t: number; pump: number; speeds: { [speedId: string]: number }; on: number; off: number; }
// The hours that start in [from, to), oldest first, one row per pump and hour, from rows held as { hour start: { pump: seconds } } (lines of the
// same hour already added up). Pure, so it can be tested.
export function pumpHourRows(hours: Map<number, { [pump: string]: { [key: string]: number } }>, from: number, to: number, pump?: number): PumpHour[] {
    const out: PumpHour[] = [];
    for (const t of Array.from(hours.keys()).filter(t => t >= from && t < to).sort((a, b) => a - b)) {
        const row = hours.get(t);
        for (const p of Object.keys(row).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
            if (typeof pump === 'number' && parseInt(p, 10) !== pump) continue;
            const speeds: { [speedId: string]: number } = {};
            let on = 0;
            for (const k of Object.keys(row[p])) { if (k === 'off') continue; speeds[k] = row[p][k]; on += row[p][k]; }
            out.push({ t: t, pump: parseInt(p, 10), speeds: speeds, on: on, off: row[p].off || 0 });
        }
    }
    return out;
}

class PumpPower {
    private getSettings: () => any;
    private timer: NodeJS.Timeout;
    private hours_ = new Map<number, HourRow>();     // what the log holds
    private bucket: { start: number; pumps: HourRow };  // what is not written yet
    private speedNow: { [pump: string]: number } = {};
    private lastSample = 0;
    private lastFlush = 0;
    private lastPrune = 0;
    private io: Promise<void> = Promise.resolve();  // writes run one at a time
    private file(): string { return path.join(process.cwd(), 'data', 'pumpPowerLog.jsonl'); }
    private copied = false;
    private onFallback: number[] = [];   // pumps counted from config.json although their speeds belong on their relays
    // Says in the log when a pump that keeps its speeds on its relays starts or stops being counted from config.json instead, which
    // happens when no relay of it has watts (cleared, or lost when the pump was saved by a dashPanel without these fields).
    private noteFallback() {
        const now: number[] = [];
        for (const p of this.settings.pumps) {
            const pump = sys.pumps.find(x => x.id === p.pump);
            if (p.speeds.length > 0 && hasRelaySpeeds(pump) && pumpTracked(p.pump) && pumpRelaySpeeds(p.pump).length === 0) now.push(p.pump);
        }
        for (const id of now) if (this.onFallback.indexOf(id) < 0) logger.info(`Pump power: no relay of pump ${sys.pumps.getItemById(id).name} has watts, so its speeds are taken from config.json. Set them on the pump page to use those instead.`);
        for (const id of this.onFallback) if (now.indexOf(id) < 0) logger.info(`Pump power: pump ${sys.pumps.getItemById(id).name} is no longer counted from config.json.`);
        this.onFallback = now;
    }
    private get settings(): PumpPowerSettings { return normalizePumpPowerSettings(this.getSettings ? this.getSettings() : undefined); }
    // The settings as they are used: each pump's speeds from its relays where they are set there.
    private get effective(): PumpPowerSettings { return effectivePumpPowerSettings(this.settings); }
    private saveSettings: (val: any) => void;
    public start(getSettings: () => any, saveSettings?: (val: any) => void) {
        if (this.timer) return;
        this.getSettings = getSettings;
        this.saveSettings = saveSettings;
        this.load();
        this.lastFlush = Date.now();
        this.timer = setInterval(() => {
            try { this.sample(); }
            catch (err) { logger.warn(`Pump power: could not take a sample: ${err.message}`); }
        }, SAMPLE_MS);
        process.on('exit', () => { try { this.flush(true); } catch (err) { /* nothing more can be done at exit */ } });
    }
    private load() {
        try {
            const f = this.file();
            if (!fs.existsSync(f)) return;
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try {
                    const o = JSON.parse(line);
                    if (o && typeof o.t === 'number' && typeof o.p === 'number' && o.s) this.addRow(o.t, o.p, { ...o.s, off: o.off || 0 });
                } catch (err) { /* a torn last line after a power loss is skipped */ }
            }
        } catch (err) { logger.warn(`Pump power: could not read the log: ${err.message}`); }
    }
    private addRow(t: number, pump: number, secs: Seconds) {
        let row = this.hours_.get(t);
        if (!row) this.hours_.set(t, row = {});
        addSeconds(row[pump] || (row[pump] = {}), secs);
    }
    // Moves the speeds in config.json onto the pump's relays, once a run, where they line up: the pump's type has a speed on each relay,
    // and every speed is bound to the relay of the pump with its own id. Only a relay with no watts yet gets a speed, so what was set on the
    // pump page is never overwritten, and a second run copies nothing. Once every speed of the pump is on its relay, the pump's entry is
    // taken out of config.json, so no out of date copy is left behind. An entry that does not line up stays, and is still used.
    public copySpeedsToPumps() {
        if (this.copied) return;
        this.copied = true;
        const done: number[] = [];
        for (const p of this.settings.pumps) {
            const pump = sys.pumps.find(x => x.id === p.pump);
            if (p.speeds.length === 0 || !hasRelaySpeeds(pump)) continue;
            const relays = pump.relays.toArray();
            const relayOf = (s: PumpPowerSpeed) => relays.find((r, i) => (r.id || i + 1) === s.id && relayMatches(r, s));
            const misfit = p.speeds.find(s => !s.connectionId || !s.deviceBinding || typeof relayOf(s) === 'undefined');
            if (misfit) {
                logger.info(`Pump power: the speeds of pump ${pump.name} are not copied onto its relays: ${misfit.name} is not on relay ${misfit.id} of the pump. They stay in use from config.json.`);
                continue;
            }
            const copied: string[] = [];
            for (const s of p.speeds) {
                const r = relayOf(s);
                if (parseFloat(r.watts as any) > 0) continue;
                r.speedName = s.name;
                r.rpm = s.rpm;
                r.watts = s.watts;
                r.priority = s.priority;
                copied.push(`${s.name} (relay ${s.id}: ${s.rpm} rpm, ${s.watts} W, priority ${s.priority})`);
            }
            if (copied.length > 0) logger.info(`Pump power: copied onto the relays of pump ${pump.name}: ${copied.join(', ')}.`);
            if (p.speeds.every(s => parseFloat(relayOf(s).watts as any) > 0)) done.push(p.pump);
        }
        if (done.length === 0 || !this.saveSettings) return;
        const raw = this.getSettings ? this.getSettings() : undefined;
        if (!raw || !Array.isArray(raw.pumps)) return;
        this.saveSettings({ ...raw, pumps: raw.pumps.filter((x: any) => done.indexOf(parseInt(x && x.pump, 10)) < 0) });
        logger.info(`Pump power: the speeds of ${done.map(id => sys.pumps.getItemById(id).name).join(', ')} are now only on the pump's relays and were removed from config.json.`);
    }
    private sample(now: number = Date.now()) {
        try { this.copySpeedsToPumps(); } catch (err) { logger.warn(`Pump power: could not copy the speeds onto the pumps: ${err.message}`); }
        const c = this.effective;
        if (c.enabled) { try { this.noteFallback(); } catch (err) { /* only a log line */ } }
        const pumps = c.enabled ? c.pumps.filter(p => p.speeds.length > 0) : [];
        const credit = this.lastSample > 0 ? Math.max(0, Math.min(now - this.lastSample, MAX_CREDIT_MS)) / 1000 : 0;
        this.lastSample = pumps.length > 0 ? now : 0;
        const speeds: { [pump: string]: number } = {};
        const start = Math.floor(now / HOUR_MS) * HOUR_MS;
        if (this.bucket && this.bucket.start !== start) this.flush();
        for (const p of pumps) {
            const pumpOn = (state.pumps.getItemById(p.pump).relay || 0) > 0;
            const id = pumpSpeedNow(p.speeds, pumpOn, s => isRelayOn(p.pump, s));
            speeds[p.pump] = id;
            if (!(credit > 0)) continue;
            if (!this.bucket) this.bucket = { start: start, pumps: {} };
            const secs = this.bucket.pumps[p.pump] || (this.bucket.pumps[p.pump] = {});
            const key = id < 0 ? 'off' : id.toString();
            secs[key] = (secs[key] || 0) + credit;
        }
        this.speedNow = speeds;
        if (now - this.lastFlush >= FLUSH_MS) this.flush();
        if (now - this.lastPrune >= DAY_MS) { this.lastPrune = now; this.prune(now, c.keepDays); }
    }
    // Adds what has been counted to the log. The normal write does not block; the one at exit has to.
    private flush(sync: boolean = false) {
        this.lastFlush = Date.now();
        const b = this.bucket;
        this.bucket = undefined;
        if (!b) return;
        let text = '';
        for (const pump of Object.keys(b.pumps)) {
            const s: Seconds = {};
            for (const k of Object.keys(b.pumps[pump])) s[k] = Math.round(b.pumps[pump][k]);
            const off = s.off || 0;
            delete s.off;
            this.addRow(b.start, parseInt(pump, 10), { ...s, off: off });
            text += JSON.stringify({ t: b.start, p: parseInt(pump, 10), s: s, off: off }) + '\n';
        }
        if (!text) return;
        const f = this.file();
        if (sync) { fs.appendFileSync(f, text, 'utf8'); return; }
        this.io = this.io.then(() => fs.promises.appendFile(f, text, 'utf8')).catch(err => { logger.warn(`Pump power: could not write the log: ${err.message}`); });
    }
    // Rewrites the log without the hours past `keepDays`, one line an hour.
    private prune(now: number, keepDays: number) {
        const cut = now - keepDays * DAY_MS;
        let removed = false;
        for (const t of Array.from(this.hours_.keys())) if (t < cut) { this.hours_.delete(t); removed = true; }
        if (!removed) return;
        let text = '';
        for (const t of Array.from(this.hours_.keys()).sort((a, b) => a - b)) {
            const row = this.hours_.get(t);
            for (const pump of Object.keys(row)) {
                const s: Seconds = { ...row[pump] };
                const off = s.off || 0;
                delete s.off;
                text += JSON.stringify({ t: t, p: parseInt(pump, 10), s: s, off: off }) + '\n';
            }
        }
        const f = this.file();
        this.io = this.io.then(async () => {
            await fs.promises.writeFile(f + '.tmp', text, 'utf8');
            await fs.promises.rename(f + '.tmp', f);
        }).catch(err => { logger.warn(`Pump power: could not rewrite the log: ${err.message}`); });
    }
    // The logged hours that start in [from, to), one row per pump and hour, with the hour under way from what is not written yet.
    public hours(from: number, to: number = Date.now(), pump?: number): PumpHour[] {
        const all = new Map<number, HourRow>();
        this.hours_.forEach((row, t) => { const copy: HourRow = {}; for (const p of Object.keys(row)) copy[p] = { ...row[p] }; all.set(t, copy); });
        if (this.bucket) {
            const row = all.get(this.bucket.start) || {};
            for (const p of Object.keys(this.bucket.pumps)) addSeconds(row[p] || (row[p] = {}), this.bucket.pumps[p]);
            all.set(this.bucket.start, row);
        }
        return pumpHourRows(all, from, to, pump);
    }
    // The starts of the periods a range is shown in, oldest first: 24 hours, 7 or 30 days, or 12 months.
    private periods(range: PumpPowerRange, now: number): number[] {
        const d = new Date(now), out: number[] = [];
        if (range === 'day') {
            const h = Math.floor(now / HOUR_MS) * HOUR_MS;
            for (let i = 23; i >= 0; i--) out.push(h - i * HOUR_MS);
        }
        else if (range === 'year') for (let i = 11; i >= 0; i--) out.push(new Date(d.getFullYear(), d.getMonth() - i, 1).getTime());
        else for (let i = (range === 'week' ? 6 : 29); i >= 0; i--) out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime());
        return out;
    }
    // The record for dashPanel: the speed each pump is at, today, this month, and the range asked for in periods.
    public report(range: PumpPowerRange = 'week', now: number = Date.now()) {
        const c = this.effective;
        const speeds: any[] = [];
        const watts: { [key: string]: number } = {};
        const now_: any[] = [];
        for (const p of c.pumps) {
            const name = sys.pumps.getItemById(p.pump).name || `Pump ${p.pump}`;
            for (const s of p.speeds) {
                watts[`${p.pump}.${s.id}`] = s.watts;
                speeds.push({ key: `${p.pump}.${s.id}`, pump: p.pump, pumpName: name, id: s.id, name: s.name, rpm: s.rpm, watts: s.watts, relay: relaySource(p.pump, s) });
            }
            const id = this.speedNow[p.pump];
            const sp = p.speeds.find(s => s.id === id);
            now_.push({ pump: p.pump, pumpName: name, on: typeof id === 'number' && id >= 0, speed: sp ? sp.name : undefined, rpm: sp ? sp.rpm : undefined, watts: sp ? sp.watts : undefined });
        }
        const d = new Date(now);
        const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
        const starts = this.periods(range, now);
        const buckets = starts.map(t => ({ t: t, seconds: {} as Seconds }));
        const sum = { today: {} as Seconds, month: {} as Seconds, range: {} as Seconds };
        const add = (t: number, pump: string, secs: Seconds) => {
            const s: Seconds = {};
            for (const k of Object.keys(secs)) if (k !== 'off') s[`${pump}.${k}`] = secs[k];
            if (t >= today) addSeconds(sum.today, s);
            if (t >= month) addSeconds(sum.month, s);
            if (t < starts[0]) return;
            for (let i = starts.length - 1; i >= 0; i--) {
                if (t >= starts[i]) { addSeconds(buckets[i].seconds, s); addSeconds(sum.range, s); break; }
            }
        };
        this.hours_.forEach((row, t) => { for (const pump of Object.keys(row)) add(t, pump, row[pump]); });
        if (this.bucket) for (const pump of Object.keys(this.bucket.pumps)) add(this.bucket.start, pump, this.bucket.pumps[pump]);
        const total = (secs: Seconds) => {
            let kwh = 0;
            for (const k of Object.keys(secs)) kwh += secs[k] * (watts[k] || 0) / 3600000;
            return { kwh: kwh, cost: c.ratePerKwh > 0 ? kwh * c.ratePerKwh : undefined, seconds: secs };
        };
        return {
            enabled: c.enabled, configured: speeds.length > 0, ratePerKwh: c.ratePerKwh, estimated: true, range: range, speeds: speeds, now: now_,
            today: total(sum.today), month: total(sum.month), total: total(sum.range), buckets: buckets.map(b => ({ t: b.t, ...total(b.seconds) })),
            missing: c.enabled ? this.missing(c, sum.range) : []
        };
    }
    // What keeps the tracking from counting all of a pump's time, for dashPanel to warn about:
    //   noSpeeds      a pump that is counted (its relays each pick a speed and Track power is on) has no speed set anywhere
    //   relayNoWatts  a bound relay of a pump counted from its relays has no watts, so time at that speed counts as no speed
    //   fallback      a pump that keeps its speeds on its relays has none there and is counted from config.json
    //   noSpeedTime   time in the range the pump ran with no speed that applies (counted at 0 W)
    private missing(c: PumpPowerSettings, rangeSecs: Seconds): any[] {
        const out: any[] = [];
        const listed = this.settings.pumps;
        for (const pump of sys.pumps.toArray()) {
            if (!hasRelaySpeeds(pump) || pump.trackPower === false) continue;
            const name = pump.name || `Pump ${pump.id}`;
            const onRelays = pumpRelaySpeeds(pump.id);
            const cfg = listed.find(p => p.pump === pump.id);
            if (onRelays.length === 0) {
                if (cfg && cfg.speeds.length > 0) out.push({ kind: 'fallback', pump: pump.id, pumpName: name });
                else out.push({ kind: 'noSpeeds', pump: pump.id, pumpName: name });
                continue;
            }
            const type = sys.board.valueMaps.pumpTypes.transform(pump.type) || {};
            const relays = pump.relays.toArray();
            for (let i = 0; i < relays.length; i++) {
                const r = relays[i];
                const id = r.id || i + 1;
                if (!r.connectionId || !r.deviceBinding || onRelays.some(s => s.id === id)) continue;
                const typeRelay = Array.isArray(type.relays) ? type.relays.find((x: any) => x.id === id) : undefined;
                const relayName = typeof r.speedName === 'string' && r.speedName.trim() ? r.speedName.trim() : type.maxRelays === 2 ? (id === 1 ? 'Low Speed' : 'High Speed') : typeRelay ? typeRelay.name : `Relay ${id}`;
                out.push({ kind: 'relayNoWatts', pump: pump.id, pumpName: name, relay: id, relayName: relayName });
            }
        }
        for (const p of c.pumps) {
            const secs = rangeSecs[`${p.pump}.0`] || 0;
            if (secs >= 60) out.push({ kind: 'noSpeedTime', pump: p.pump, pumpName: sys.pumps.getItemById(p.pump).name || `Pump ${p.pump}`, seconds: Math.round(secs) });
        }
        return out;
    }
}
export const pumpPower = new PumpPower();
