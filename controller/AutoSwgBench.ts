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

// SWG Assist Model Bench: runs the projection models of AutoSwgBenchModel.ts beside SWG Assist and scores them against each new FC test. It never
// changes the SWG % or anything SWG Assist does: it reads the logs and writes only its own files, next to poolConfig.json:
//   data/autoSwgBench.json          settings: enabled, the pool geometry, the variants (an edit to a variant makes a new version)
//   data/autoSwgBenchFits.jsonl     one line per variant version at each automatic check: the fit it froze then
//   data/autoSwgBenchScores.jsonl   one line per variant version, test, horizon and mode: the projection and the miss
//   data/autoSwgBenchCya.jsonl      the CYA record: each new CYA test (the path's value just before it, the test, how it was taken, the rain k before
//                                   and after, the advice rule in force) and the model-drift result of each check (advice rule 3)
// Rows older than 18 months are dropped. Replay rows (worked out afterwards over the past) carry `replay: true` and are kept apart from live rows.
//
// At each automatic check (onCheck) every variant version is fitted on what is known then. When a new FC test arrives (onReadings) every version
// projects it from the reading before (horizon 'next') and from the one before that ('skip', the weekly-testing case), with the fit it froze at the
// last check before the test (no look-ahead): 'nowcast' with the weather that happened, 'forecast' with only the clear sky and the recent clearness.
// The live projection is scored from SWG Assist's own projected FC at each test (AutoSwgProjection.ts 'reading' points).
//
// CYA (AutoSwgBenchCya.ts): the path variants use the CYA between tests as it was known at each check. When a new CYA test arrives the path since the
// test before is redrawn to land on it; the scores already recorded are never rewritten, but each score since the test before gets a "revised
// hindcast" (revisedProj, revisedMiss): the same frozen fit with the corrected path, for tuning only. The CYA test advice is set on
// state.autoSwg.benchCyaAdvice (advisory only) after each check and each new reading.
//
// Inputs from modules that are not on this branch (the weather log, the water temperature history, the pump power log) come through sources
// registered at start-up (setBenchWeatherSource and the others); a missing source makes the variants that need it report the input as missing.
// Any failure is logged and skipped; nothing reaches SWG Assist.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { sys } from './Equipment';
import { state } from './State';
import {
    BenchGeometry, BenchHour, BenchPumpHour, BenchSources, BenchTempHour, BenchVariant, BenchWeatherHour, buildHourlyInputs, chlorinePpm,
    CyaSource, CyaTest, cyaFor, DAY_MS, DEFAULT_VARIANTS, FcReading, Fit, fitVariant, gapDays, generationBetween, HOUR_MS, inputCoverage, InputStarts, inputStarts,
    Interval, intervalsFrom, normalizeGeometry, normalizeScoring, pairedDifference, plainRate, poundsToPpm, projectLoss, recentClearness, ScoreFlag, scoreFlags,
    ScoringSettings, scoreSummary, spanCoverage
} from './AutoSwgBenchModel';
import {
    CyaAddition, CyaAdvice, cyaAdvice, CyaPath, cyaPath, CyaSettings, defaultRainK, DriftCheck, modelDrift, normalizeCyaSettings, pathSamples, polygonArea
} from './AutoSwgBenchCya';
import {
    buildCalendar, DEFAULT_SIM_SETTINGS, fitModelPlant, liveProjector, modelProjector, outcome, plainProjector, Projector, SimData, SimOutcome, SimRhythm, SimSettings,
    simulate, summarizeOutcomes, testsFor
} from './AutoSwgBenchSim';
import { archivedChlorineAdditions, archivedCyaReadings, archivedFcReadings, archivedSaltAdditions, archivedStabilizerAdditions, archivedSwgEvents, saltAdditionPpm } from './PoolMathArchive';
import { readAutoSwgHistory, toLocalSwgEntries } from './AutoSwgHistory';
import { projectionLog } from './AutoSwgProjection';
import { chlorinatorLog } from './ChlorinatorLog';
import { chlorinatorPowerLog } from './ChlorinatorPowerLog';
import { firstChlorinatorId } from './ChlorinatorLogService';
import { CycleContext, mergeSwgEntries, pctAtFromHours, SwgEntry } from './ChlorinatorUsage';
import { saltHistory } from './AutoSwgSaltHistory';

const KEEP_MS = 548 * DAY_MS;          // 18 months
const SCORE_DAYS = 60;                 // how far back onReadings looks for tests not scored yet
const PAUSE_MS = 40;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- input sources

export type BenchWeatherSource = (from: number, to: number) => BenchWeatherHour[];
export type BenchWaterTempSource = (from: number, to: number) => BenchTempHour[];
export type BenchPumpSource = (from: number, to: number) => BenchPumpHour[];
let weatherSource: BenchWeatherSource | undefined;
let waterTempSource: BenchWaterTempSource | undefined;
let pumpSource: BenchPumpSource | undefined;
export function setBenchWeatherSource(fn: BenchWeatherSource | undefined) { weatherSource = fn; }
export function setBenchWaterTempSource(fn: BenchWaterTempSource | undefined) { waterTempSource = fn; }
export function setBenchPumpSource(fn: BenchPumpSource | undefined) { pumpSource = fn; }
function fromSource<T>(name: string, fn: ((a: number, b: number) => T[]) | undefined, from: number, to: number): T[] {
    if (!fn) return [];
    try { return fn(from, to) || []; }
    catch (err) { logger.warn(`SWG Assist bench: the ${name} source failed: ${err && err.message}`); return []; }
}

// ---------------------------------------------------------------- settings and files

export interface BenchSettings { enabled: boolean; geometry: BenchGeometry; variants: BenchVariant[]; cya: CyaSettings; scoring: ScoringSettings; }
export interface BenchFitRow { t: number; id: string; v: number; fit?: Fit; cya?: number; clearness?: number; replay?: boolean; }
export type BenchMode = 'nowcast' | 'forecast' | 'live';
// sunShare: the share of the projected loss that is the sun term (models). revised*: the revised hindcast after a later CYA test (see the top).
// gen: the chlorine credited over the gap; cov: its input coverage; flags: as judged when the row was written (the scoreboard judges again with the
// settings of the day, see scoreFlags).
export interface BenchScoreRow {
    t: number; id: string; v: number; horizon: 'next' | 'skip'; mode: BenchMode;
    t1: number; f1: number; test: number; proj: number; miss: number; days: number; fitAt?: number; replay?: boolean;
    sunShare?: number; revisedProj?: number; revisedMiss?: number; revisedAt?: number;
    gen?: number; cov?: number; flags?: ScoreFlag[];
}
export interface BenchCyaTestRow {
    t: number; kind: 'test'; ppm: number; projected?: number; status?: string; reason?: string; rainKBefore?: number; rainKAfter?: number;
    adviceRule?: number; baseline?: boolean; revised?: number;
}
export interface BenchDriftRow extends DriftCheck { kind: 'drift'; id: string; v: number; }
// The variant the CYA advice and the drift check use: sun-cya-30, or the first model variant on the CYA path.
const MAIN_VARIANT = 'sun-cya-30';
const BASELINE_DAYS = 120;

function dataFile(name: string): string { return path.join(process.cwd(), 'data', name); }
const SETTINGS_FILE = 'autoSwgBench.json', FITS_FILE = 'autoSwgBenchFits.jsonl', SCORES_FILE = 'autoSwgBenchScores.jsonl', CYA_FILE = 'autoSwgBenchCya.jsonl';

function sameDefinition(a: BenchVariant, b: BenchVariant): boolean {
    const strip = (v: BenchVariant) => JSON.stringify(Object.assign({}, v, { version: 0, label: undefined, retired: undefined }));
    return strip(a) === strip(b);
}

export function normalizeVariant(raw: any): BenchVariant | undefined {
    if (!raw || typeof raw.id !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(raw.id)) return undefined;
    const kind = raw.kind === 'live' || raw.kind === 'plain' || raw.kind === 'model' ? raw.kind : undefined;
    if (!kind) return undefined;
    const v: BenchVariant = { id: raw.id, version: Number(raw.version) > 0 ? Math.floor(Number(raw.version)) : 1, kind: kind };
    if (typeof raw.label === 'string') v.label = raw.label.slice(0, 80);
    if (raw.retired === true) v.retired = true;
    const num = (k: string, lo: number, hi: number) => { const x = Number(raw[k]); if (raw[k] !== undefined && raw[k] !== null && isFinite(x)) (v as any)[k] = Math.max(lo, Math.min(hi, x)); };
    if (kind === 'plain') { num('windowDays', 1, 60); if (!v.windowDays) v.windowDays = 14; }
    if (kind === 'model') {
        num('fitDays', 7, 120); num('ridge', 0, 100); num('minIntervals', 2, 50); num('minGapDays', 0, 3);
        v.sun = ['none', 'station', 'pool', 'poolHourHigh', 'clearPool'].indexOf(raw.sun) >= 0 ? raw.sun : 'pool';
        v.fcTerm = raw.fcTerm === 'fc' ? 'fc' : 'fcCya';
        v.fcPath = raw.fcPath === 'held' ? 'held' : 'model';
        // not set: CYA held at the last test (how version 1 of the models ran); the switches are only stored when on
        if (raw.cya === 'path' || raw.cya === 'held') v.cya = raw.cya;
        if (raw.temp === true) v.temp = true;
        if (raw.rainWash === true) v.rainWash = true;
    }
    return v;
}

// A local date for the advice text (YYYY-MM-DD).
function localDate(t: number): string {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const round = (x: number, d: number = 2) => { const m = Math.pow(10, d); return Math.round(x * m) / m; };

class AutoSwgBench {
    private settings: BenchSettings | undefined;
    private busy = false;
    private lastCheck: number | undefined;
    private lastScored: number | undefined;
    private lastError: string | undefined;
    private replayState: { running: boolean; since?: number; done?: number; total?: number; finishedAt?: number; error?: string } = { running: false };
    private simState: { running: boolean; request?: any; done?: number; total?: number; startedAt?: number; finishedAt?: number; error?: string; results?: any } = { running: false };

    public getSettings(): BenchSettings {
        if (this.settings) return this.settings;
        let raw: any;
        try { raw = JSON.parse(fs.readFileSync(dataFile(SETTINGS_FILE), 'utf8')); }
        catch (err) { if (err && err.code !== 'ENOENT') logger.warn(`SWG Assist bench: could not read ${SETTINGS_FILE}: ${err.message}`); }
        const variants: BenchVariant[] = raw && Array.isArray(raw.variants) ? raw.variants.map(normalizeVariant).filter((v: any) => !!v) : DEFAULT_VARIANTS.map(v => Object.assign({}, v));
        // a default variant added in a later release joins a stored list (the stored ones are kept as they are)
        for (const d of DEFAULT_VARIANTS) if (!variants.some(v => v.id === d.id)) variants.push(Object.assign({}, d));
        this.settings = { enabled: !raw || raw.enabled !== false, geometry: normalizeGeometry(raw && raw.geometry), variants: variants, cya: normalizeCyaSettings(raw && raw.cya), scoring: normalizeScoring(raw && raw.scoring) };
        return this.settings;
    }
    private writeSettings(s: BenchSettings) {
        const file = dataFile(SETTINGS_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2), 'utf8');
        fs.renameSync(`${file}.tmp`, file);
        this.settings = s;
    }
    // Changes the settings. A variant whose definition changed gets the next version (its old version's rows stay, scored apart); one that is not
    // in the list is kept; `retired` hides it from the checks.
    public putSettings(body: any): BenchSettings {
        const cur = this.getSettings();
        const next: BenchSettings = { enabled: cur.enabled, geometry: cur.geometry, variants: cur.variants.map(v => Object.assign({}, v)), cya: cur.cya, scoring: cur.scoring };
        if (body && typeof body.enabled === 'boolean') next.enabled = body.enabled;
        // the scoring settings, as { scoring: {...} } or as maxGapDays, minCoverage, minGapN at the top
        if (body && typeof body === 'object') {
            const sc = Object.assign({}, body.scoring && typeof body.scoring === 'object' ? body.scoring : {});
            for (const k of ['maxGapDays', 'minCoverage', 'minGapN']) if (body[k] !== undefined) sc[k] = body[k];
            if (Object.keys(sc).length) next.scoring = normalizeScoring(Object.assign({}, cur.scoring, sc));
        }
        if (body && body.cya && typeof body.cya === 'object') next.cya = normalizeCyaSettings(Object.assign({}, cur.cya, body.cya));
        if (body && body.geometry) next.geometry = normalizeGeometry(Object.assign({}, cur.geometry, body.geometry));
        if (body && Array.isArray(body.variants)) {
            for (const raw of body.variants) {
                const v = normalizeVariant(Object.assign({ version: 1 }, raw));
                if (!v) continue;
                const k = next.variants.findIndex(x => x.id === v.id);
                if (k < 0) { v.version = 1; next.variants.push(v); continue; }
                const old = next.variants[k];
                v.version = sameDefinition(old, v) ? old.version : old.version + 1;
                next.variants[k] = v;
            }
        }
        this.writeSettings(next);
        return next;
    }

    private readRows<T>(name: string): T[] {
        const out: T[] = [];
        try {
            for (const line of fs.readFileSync(dataFile(name), 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try { out.push(JSON.parse(line)); } catch (err) { /* a line cut short by a power loss */ }
            }
        }
        catch (err) { if (err && err.code !== 'ENOENT') logger.warn(`SWG Assist bench: could not read ${name}: ${err.message}`); }
        return out;
    }
    private appendRows(name: string, rows: any[]) {
        if (!rows.length) return;
        const file = dataFile(name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
    // Rewrites a file keeping the rows `keep` accepts and those not older than 18 months.
    private rewriteRows(name: string, keep: (r: any) => boolean) {
        const cut = Date.now() - KEEP_MS;
        const rows = this.readRows<any>(name).filter(r => r && r.t >= cut && keep(r));
        const file = dataFile(name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
        fs.renameSync(`${file}.tmp`, file);
    }
    private writeAllRows(name: string, rows: any[]) {
        const file = dataFile(name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
        fs.renameSync(`${file}.tmp`, file);
    }

    // ------------------------------------------------------------ inputs

    // Everything the models read for [from, to]: the hourly rows, the FC readings, the CYA tests, and the intervals between readings.
    // CYA: the tests, the stabilizer and salt additions, and the path as known at any moment (cyaPathAt, kept for the life of these inputs).
    public gatherInputs(from: number, to: number): {
        rows: BenchHour[]; readings: FcReading[]; cya: CyaTest[]; intervals: Interval[]; sources: BenchSources; gallons: number;
        cyaAdds: CyaAddition[]; saltAdds: CyaAddition[]; cyaSrc: CyaSource; cyaPathAt: (asOf: number) => CyaPath;
        starts: InputStarts; skipFit: (iv: Interval) => boolean;
    } {
        const cfg: any = sys.autoSwg;
        const gallons = cfg.gallons > 0 ? cfg.gallons : 0;
        const id = typeof cfg.chlorinatorId === 'number' ? cfg.chlorinatorId : firstChlorinatorId();
        const chlor: any = typeof id === 'number' ? sys.chlorinators.find(c => c.id === id) : undefined;
        const days = Math.ceil((Date.now() - from) / DAY_MS) + 2;
        const outputHours = typeof id === 'number' ? chlorinatorLog.read(days, Date.now(), id, firstChlorinatorId()) : [];
        let cycle: CycleContext | undefined;
        if (chlor && chlor.cycleHours > 0) {
            const events = chlorinatorPowerLog.read(days + 1, Date.now(), id).map(e => ({ t: new Date(e.t).getTime(), on: e.on }));
            if (events.length) cycle = { cycle: { cycleHours: chlor.cycleHours, restartsOnPower: chlor.cycleRestartsOnPower, burstFirst: chlor.burstFirst }, events: events, since: events[0].t, pctAt: pctAtFromHours(outputHours) };
        }
        const own: SwgEntry[] = toLocalSwgEntries(readAutoSwgHistory()).map(e => ({ ts: new Date(e.ts).getTime(), ppmPerDay: e.ppmPerDay, hrs: e.hrs, pct: e.pct }));
        const pm: SwgEntry[] = archivedSwgEvents().map(e => ({ ts: e.ts.getTime(), ppmPerDay: e.ppmPerDay, hrs: e.hrs, pct: e.pct }));
        const loc: any = sys.general && sys.general.location;
        const sources: BenchSources = {
            lat: loc && typeof loc.latitude === 'number' ? loc.latitude : undefined, lon: loc && typeof loc.longitude === 'number' ? loc.longitude : undefined,
            gallons: gallons, cellLbsPerDay: chlor ? chlor.cellLbsPerDay : (cfg.swgLbsPerDay || 0),
            outputHours: outputHours, cycle: cycle, swgEntries: mergeSwgEntries(own, pm),
            chlorine: cfg.creditChlorineAdditions === false ? [] : archivedChlorineAdditions().map(a => ({ ts: a.ts.getTime(), ppm: chlorinePpm(a.percent, a.ml, gallons) })),
            weather: fromSource('weather', weatherSource, from - DAY_MS, to),
            waterTemp: fromSource('water temperature', waterTempSource, from, to),
            pump: fromSource('pump', pumpSource, from, to),
            salt: saltHistory.daily(days).map(d => ({ t: new Date(d.date + 'T12:00:00').getTime(), ppm: d.median }))
        };
        const rows = buildHourlyInputs(sources, from, to, this.getSettings().geometry);
        const readings = archivedFcReadings().map(r => ({ t: r.ts.getTime(), fc: r.value })).filter(r => r.t >= from && r.t <= to);
        const cya = archivedCyaReadings().map(r => ({ t: r.ts.getTime(), ppm: r.value }));
        const cyaAdds: CyaAddition[] = archivedStabilizerAdditions(gallons || undefined).map(a => ({ t: a.ts.getTime(), ppm: a.ppm })).filter(a => a.ppm > 0);
        const saltAdds: CyaAddition[] = archivedSaltAdditions().map(a => ({ t: a.ts.getTime(), ppm: saltAdditionPpm(a.pounds, gallons) })).filter(a => a.ppm > 0);
        const settings = this.getSettings();
        const defaultK = defaultRainK(polygonArea(settings.geometry.outline), gallons);
        const memo = new Map<number, CyaPath>();
        const cyaPathAt = (asOf: number): CyaPath => {
            let p = memo.get(asOf);
            if (!p) { p = cyaPath(cya, cyaAdds, rows, settings.cya, asOf, { saltAdds: saltAdds, defaultK: defaultK }); memo.set(asOf, p); }
            return p;
        };
        // the intervals the model fits leave out: a long gap or thin inputs (see scoreFlags)
        const starts = inputStarts(rows), sc = settings.scoring;
        const skipFit = (iv: Interval) => gapDays(iv) > sc.maxGapDays || spanCoverage(rows, iv.t1, iv.t2, starts) < sc.minCoverage;
        return {
            rows: rows, readings: readings, cya: cya, intervals: intervalsFrom(readings, rows), sources: sources, gallons: gallons,
            cyaAdds: cyaAdds, saltAdds: saltAdds, cyaSrc: { tests: cya, path: (asOf: number) => cyaPathAt(asOf).at }, cyaPathAt: cyaPathAt,
            starts: starts, skipFit: skipFit
        };
    }
    private maxFitDays(): number { return Math.max(30, ...this.getSettings().variants.map(v => Math.max(v.fitDays || 0, v.windowDays || 0) + 2)); }

    // ------------------------------------------------------------ fit and score

    // What a variant freezes at a check: its fit (models), its rate (plain), and for the forecast the CYA and the recent clearness.
    private fitAt(v: BenchVariant, inp: ReturnType<AutoSwgBench['gatherInputs']>, t: number, replay: boolean): BenchFitRow | undefined {
        if (v.kind === 'live') return undefined;
        const row: BenchFitRow = { t: t, id: v.id, v: v.version };
        if (replay) row.replay = true;
        if (v.kind === 'plain') {
            const r = plainRate(inp.intervals, t, v.windowDays || 14);
            if (typeof r !== 'number') return undefined;
            row.fit = { a: 0, b: r, n: 0, plainRate: r };
            return row;
        }
        const fit = fitVariant(v, inp.intervals, inp.rows, inp.cyaSrc, t, inp.skipFit);
        if (!fit) return undefined;
        row.fit = fit;
        const c = recentClearness(inp.rows, t);
        if (typeof c === 'number') row.clearness = Math.round(c * 1000) / 1000;
        row.cya = round(cyaFor(v, inp.cyaSrc, t)(t), 1);
        return row;
    }

    // The scores of one test for one variant from its frozen fit: both horizons, nowcast and (for models) forecast.
    private scoreTest(v: BenchVariant, inp: ReturnType<AutoSwgBench['gatherInputs']>, k: number, fit: BenchFitRow, replay: boolean): BenchScoreRow[] {
        const out: BenchScoreRow[] = [];
        const test = inp.readings[k];
        for (const [horizon, back] of [['next', 1], ['skip', 2]] as ['next' | 'skip', number][]) {
            const start = inp.readings[k - back];
            if (!start || !(test.t - start.t > 0.3 * DAY_MS)) continue;
            const gen = generationBetween(inp.rows, start.t, test.t);
            const modes: ('nowcast' | 'forecast')[] = v.kind === 'model' ? ['nowcast', 'forecast'] : ['nowcast'];
            for (const mode of modes) {
                let loss: number | undefined;
                if (v.kind === 'plain' || (fit.fit && fit.fit.fallback)) loss = fit.fit.b * (test.t - start.t) / DAY_MS;
                else if (mode === 'forecast' && typeof fit.clearness !== 'number') loss = undefined;
                else loss = projectLoss(v, fit.fit, inp.rows, inp.cyaSrc, fit.t, start.t, start.fc, test.t, mode === 'forecast' ? fit.clearness : undefined);
                if (typeof loss !== 'number' || !isFinite(loss)) continue;
                const proj = start.fc + gen - loss;
                const days = (test.t - start.t) / DAY_MS;
                const row: BenchScoreRow = {
                    t: test.t, id: v.id, v: v.version, horizon: horizon, mode: mode, t1: start.t, f1: start.fc, test: test.fc,
                    proj: Math.round(proj * 100) / 100, miss: Math.round((test.fc - proj) * 100) / 100, days: Math.round(gapDays({ t1: start.t, t2: test.t }) * 100) / 100, fitAt: fit.t
                };
                // the sun's share of the projected loss: what is left after the steady demand (and the rain wash-in)
                if (v.kind === 'model' && !fit.fit.fallback && loss > 0) row.sunShare = round(Math.max(0, Math.min(1, 1 - fit.fit.b * days / loss)));
                this.markRow(row, inp, gen);
                if (replay) row.replay = true;
                out.push(row);
            }
        }
        return out;
    }

    private liveScores(v: BenchVariant, inp: ReturnType<AutoSwgBench['gatherInputs']>, have: Set<string>, since: number): BenchScoreRow[] {
        const out: BenchScoreRow[] = [];
        const points = projectionLog.read(Math.ceil((Date.now() - since) / DAY_MS) + 1).filter(p => p.kind === 'reading');
        for (let k = 1; k < inp.readings.length; k++) {
            const test = inp.readings[k];
            if (test.t < since || have.has(`${v.id}|${v.version}|${test.t}|next|live`)) continue;
            const p = points.find(x => x.t === test.t);
            if (!p) continue;
            const start = inp.readings[k - 1];
            const row: BenchScoreRow = { t: test.t, id: v.id, v: v.version, horizon: 'next', mode: 'live', t1: start.t, f1: start.fc, test: test.fc, proj: p.fc, miss: Math.round((test.fc - p.fc) * 100) / 100, days: Math.round(gapDays({ t1: start.t, t2: test.t }) * 100) / 100 };
            this.markRow(row, inp, generationBetween(inp.rows, start.t, test.t));
            out.push(row);
        }
        return out;
    }
    // The chlorine credited over a scored pair, its input coverage, and its flags under today's settings.
    private markRow(row: BenchScoreRow, inp: ReturnType<AutoSwgBench['gatherInputs']>, gen: number) {
        row.gen = round(gen);
        row.cov = round(spanCoverage(inp.rows, row.t1, row.t, inp.starts), 3);
        const f = scoreFlags(row, this.getSettings().scoring);
        if (f.length) row.flags = f;
    }

    // At an automatic check: every enabled variant version freezes its fit. Never throws.
    public async onCheck(now: number = Date.now()): Promise<void> {
        const s = this.getSettings();
        if (!s.enabled || this.busy) return;
        this.busy = true;
        try {
            const inp = this.gatherInputs(now - (this.maxFitDays() + 20) * DAY_MS, now);
            const rows: BenchFitRow[] = [];
            for (const v of s.variants) {
                if (v.retired) continue;
                try { const r = this.fitAt(v, inp, now, false); if (r) rows.push(r); }
                catch (err) { logger.warn(`SWG Assist bench: could not fit ${v.id} v${v.version}: ${err && err.message}`); }
                await pause(PAUSE_MS);
            }
            this.appendRows(FITS_FILE, rows);
            // advice rule 3: the burn of the last two weeks with CYA left free, against the main variant's fit
            try {
                const main = this.mainVariant();
                const f = main && rows.find(r => r.id === main.id && r.v === main.version);
                if (main && f && f.fit) {
                    const d = modelDrift(main, f.fit, inp.intervals.filter(iv => !inp.skipFit(iv)), inp.rows, cyaFor(main, inp.cyaSrc, now), now);
                    this.appendRows(CYA_FILE, [Object.assign({ kind: 'drift', id: main.id, v: main.version }, d)]);
                }
            }
            catch (err) { logger.warn(`SWG Assist bench: the CYA drift check failed: ${err && err.message}`); }
            this.refreshAdvice(inp, now);
            this.lastCheck = now;
            this.lastError = undefined;
        }
        catch (err) { this.lastError = err && err.message; logger.warn(`SWG Assist bench: the check failed: ${err && err.message}`); }
        finally { this.busy = false; }
    }
    private mainVariant(): BenchVariant | undefined {
        const vs = this.getSettings().variants.filter(v => !v.retired && v.kind === 'model');
        return vs.find(v => v.id === MAIN_VARIANT) || vs.find(v => v.cya === 'path') || vs[0];
    }

    // ------------------------------------------------------------ CYA

    // The CYA test advice as of now, set on state.autoSwg.benchCyaAdvice (and emitted) when it changed. Never throws.
    private lastAdvice: CyaAdvice | undefined;
    private refreshAdvice(inp: ReturnType<AutoSwgBench['gatherInputs']>, now: number) {
        try {
            const main = this.mainVariant();
            const drift = this.readRows<any>(CYA_FILE).filter(r => r.kind === 'drift' && (!main || (r.id === main.id && r.v === main.version))) as BenchDriftRow[];
            const misses = main ? this.readRows<BenchScoreRow>(SCORES_FILE)
                .filter(r => !r.replay && r.id === main.id && r.v === main.version && r.horizon === 'next' && r.mode === 'nowcast')
                .map(r => ({ t: r.t, miss: r.miss, sunShare: r.sunShare })) : [];
            const advice = cyaAdvice(now, inp.cyaPathAt(now), inp.cyaAdds, drift, misses, localDate);
            this.lastAdvice = advice;
            if (JSON.stringify(state.autoSwg.benchCyaAdvice || null) !== JSON.stringify(advice)) {
                state.autoSwg.benchCyaAdvice = advice;
                state.autoSwg.emitEquipmentChange();
            }
        }
        catch (err) { logger.warn(`SWG Assist bench: the CYA advice failed: ${err && err.message}`); }
    }

    // Records each CYA test not recorded yet (the first time, those of the last BASELINE_DAYS days, as a baseline with no revision), and gives every
    // score since the test before it a revised hindcast with the corrected path. Live scores keep their projection and miss.
    private recordCyaTests(inp: ReturnType<AutoSwgBench['gatherInputs']>, now: number): number {
        const recorded = this.readRows<any>(CYA_FILE).filter(r => r.kind === 'test') as BenchCyaTestRow[];
        const lastT = recorded.reduce((m, r) => Math.max(m, r.t), -Infinity);
        const first = recorded.length === 0;
        const known = inp.cya.filter(c => c.t <= now && c.ppm > 0 && c.t > lastT && (!first || c.t >= now - BASELINE_DAYS * DAY_MS)).sort((a, b) => a.t - b.t);
        if (!known.length) return 0;
        const after = inp.cyaPathAt(now);
        const rule = this.lastAdvice ? this.lastAdvice.rule : (state.autoSwg.benchCyaAdvice && state.autoSwg.benchCyaAdvice.rule);
        const rows: BenchCyaTestRow[] = [];
        let scores: BenchScoreRow[] | undefined, fits: BenchFitRow[] | undefined, revised = 0;
        const variants = this.getSettings().variants;
        for (const T of known) {
            const before = inp.cyaPathAt(T.t - 1);
            const note = after.notes.find(n => n.t === T.t);
            const row: BenchCyaTestRow = {
                t: T.t, kind: 'test', ppm: T.ppm, projected: round(before.at(T.t), 1), status: note ? note.status : undefined, reason: note ? note.reason : undefined,
                rainKBefore: round(before.rainK, 4), rainKAfter: round(after.rainK, 4), adviceRule: typeof rule === 'number' ? rule : undefined
            };
            if (first) { row.baseline = true; rows.push(row); continue; }
            // the revised hindcast: the scores whose gap starts after the test before this one
            const prev = inp.cya.filter(c => c.t < T.t && c.ppm > 0).sort((a, b) => a.t - b.t).pop();
            const since = prev ? prev.t : T.t - 60 * DAY_MS;
            if (!scores) scores = this.readRows<BenchScoreRow>(SCORES_FILE);
            if (!fits) fits = this.readRows<BenchFitRow>(FITS_FILE).filter(f => !f.replay);
            const corrected: CyaSource = { tests: inp.cya, path: () => after.at };
            let n = 0;
            for (const r of scores) {
                if (r.replay || r.mode !== 'nowcast' || r.t1 < since || r.t > now) continue;
                const v = variants.find(x => x.id === r.id && x.version === r.v);
                if (!v || v.kind !== 'model' || v.cya !== 'path') continue;
                const f = fits.find(x => x.id === r.id && x.v === r.v && x.t === r.fitAt);
                if (!f || !f.fit || f.fit.fallback) continue;
                const loss = projectLoss(v, f.fit, inp.rows, corrected, f.t, r.t1, r.f1, r.t);
                if (typeof loss !== 'number' || !isFinite(loss)) continue;
                const proj = r.f1 + generationBetween(inp.rows, r.t1, r.t) - loss;
                r.revisedProj = round(proj); r.revisedMiss = round(r.test - proj); r.revisedAt = T.t;
                n++;
            }
            row.revised = n; revised += n;
            rows.push(row);
        }
        if (scores && revised) this.writeAllRows(SCORES_FILE, scores);
        this.appendRows(CYA_FILE, rows);
        logger.info(`SWG Assist bench: ${rows.length} CYA test${rows.length === 1 ? '' : 's'} recorded${revised ? `, ${revised} revised hindcast${revised === 1 ? '' : 's'}` : ''}.`);
        return rows.length;
    }

    // After new FC readings: every enabled variant version scores each test of the last SCORE_DAYS days it has not scored, with the fit it froze at
    // the last check before the test. Never throws.
    public async onReadings(now: number = Date.now()): Promise<void> {
        const s = this.getSettings();
        if (!s.enabled || this.busy) return;
        this.busy = true;
        try {
            const since = now - SCORE_DAYS * DAY_MS;
            const inp = this.gatherInputs(since - (this.maxFitDays() + 20) * DAY_MS, now);
            const scores = this.readRows<BenchScoreRow>(SCORES_FILE).filter(r => !r.replay);
            const have = new Set(scores.map(r => `${r.id}|${r.v}|${r.t}|${r.horizon}|${r.mode}`));
            const fits = this.readRows<BenchFitRow>(FITS_FILE).filter(r => !r.replay && r.t >= since - 30 * DAY_MS).sort((a, b) => a.t - b.t);
            const fresh: BenchScoreRow[] = [];
            for (const v of s.variants) {
                if (v.retired) continue;
                try {
                    if (v.kind === 'live') { fresh.push(...this.liveScores(v, inp, have, since)); continue; }
                    const mine = fits.filter(f => f.id === v.id && f.v === v.version && f.fit);
                    for (let k = 1; k < inp.readings.length; k++) {
                        const test = inp.readings[k];
                        if (test.t < since || have.has(`${v.id}|${v.version}|${test.t}|next|nowcast`)) continue;
                        let fit: BenchFitRow | undefined;
                        for (const f of mine) { if (f.t < test.t) fit = f; else break; }
                        if (!fit) continue;
                        fresh.push(...this.scoreTest(v, inp, k, fit, false).filter(r => !have.has(`${r.id}|${r.v}|${r.t}|${r.horizon}|${r.mode}`)));
                    }
                }
                catch (err) { logger.warn(`SWG Assist bench: could not score ${v.id} v${v.version}: ${err && err.message}`); }
                await pause(PAUSE_MS);
            }
            this.appendRows(SCORES_FILE, fresh);
            if (fresh.length) logger.info(`SWG Assist bench: ${fresh.length} projection score${fresh.length === 1 ? '' : 's'} added.`);
            try { this.recordCyaTests(inp, now); }
            catch (err) { logger.warn(`SWG Assist bench: recording the CYA tests failed: ${err && err.message}`); }
            this.refreshAdvice(inp, now);
            this.lastScored = now;
            this.lastError = undefined;
        }
        catch (err) { this.lastError = err && err.message; logger.warn(`SWG Assist bench: scoring failed: ${err && err.message}`); }
        finally { this.busy = false; }
    }

    // Works the checks and scores out over the past, from `since`, as if the bench had been running: each test is scored with the fit as of the
    // last 10:00 or 22:00 check before it. Earlier replay rows are replaced; live rows are never touched. Runs in slices.
    public async replay(since: number): Promise<void> {
        if (this.replayState.running) return;
        this.replayState = { running: true, since: since, done: 0 };
        try {
            const s = this.getSettings();
            const inp = this.gatherInputs(since - (this.maxFitDays() + 20) * DAY_MS, Date.now());
            const tests = inp.readings.map((r, k) => ({ r: r, k: k })).filter(x => x.k > 0 && x.r.t >= since);
            const variants = s.variants.filter(v => !v.retired && v.kind !== 'live');
            this.replayState.total = tests.length * variants.length;
            const fits: BenchFitRow[] = [], scores: BenchScoreRow[] = [];
            for (const v of variants) {
                const cache = new Map<number, BenchFitRow | undefined>();
                for (const x of tests) {
                    const check = lastCheckBefore(x.r.t);
                    if (!cache.has(check)) { const f = this.fitAt(v, inp, check, true); cache.set(check, f); if (f) fits.push(f); }
                    const fit = cache.get(check);
                    if (fit && fit.fit) scores.push(...this.scoreTest(v, inp, x.k, fit, true));
                    this.replayState.done++;
                    if (this.replayState.done % 10 === 0) await pause(PAUSE_MS);
                }
            }
            this.rewriteRows(FITS_FILE, r => !r.replay);
            this.rewriteRows(SCORES_FILE, r => !r.replay);
            this.appendRows(FITS_FILE, fits);
            this.appendRows(SCORES_FILE, scores);
            logger.info(`SWG Assist bench: replay from ${new Date(since).toISOString()} wrote ${scores.length} scores for ${variants.length} variants.`);
        }
        catch (err) { this.replayState.error = err && err.message; logger.warn(`SWG Assist bench: replay failed: ${err && err.message}`); }
        finally { this.replayState.running = false; this.replayState.finishedAt = Date.now(); }
    }

    // ------------------------------------------------------------ the scoreboard

    public scores(days: number): BenchScoreRow[] {
        const from = Date.now() - days * DAY_MS;
        return this.readRows<BenchScoreRow>(SCORES_FILE).filter(r => r.t >= from).sort((a, b) => a.t - b.t);
    }
    public scoresCsv(days: number): string {
        const cols = ['t', 'id', 'v', 'horizon', 'mode', 'replay', 't1', 'f1', 'test', 'proj', 'miss', 'days', 'fitAt', 'sunShare', 'revisedProj', 'revisedMiss', 'revisedAt', 'gen', 'cov', 'flags'];
        const iso = (x: any) => typeof x === 'number' && x > 1e12 ? new Date(x).toISOString() : x;
        const cell = (x: any) => typeof x === 'undefined' ? '' : Array.isArray(x) ? x.join(' ') : String(x);
        return [cols.join(',')].concat(this.scores(days).map(r => cols.map(c => cell(iso((r as any)[c]))).join(','))).join('\n') + '\n';
    }

    // For each variant version: live rows (last 90 days and all time) and replay rows apart, nowcast at the next test first, the paired difference
    // in absolute miss against the live projection on the same tests, the band the variant would itself show, the last ten misses, input coverage.
    public scoreboard(): any {
        const s = this.getSettings();
        const all = this.readRows<BenchScoreRow>(SCORES_FILE);
        const now = Date.now();
        // flagged pairs (see scoreFlags) are judged with today's settings, the same way for live and every challenger; they stay in the rows but out of
        // the headline figures and the paired difference
        const sc = s.scoring;
        const flagsOf = (r: BenchScoreRow) => scoreFlags(r, sc);
        const live = all.filter(r => r.id === 'live' && r.mode === 'live' && !r.replay && !flagsOf(r).length);
        const liveByT = new Map<number, number>(live.map(r => [r.t, r.miss] as [number, number]));
        // the paired difference only against a live series of the same horizon: live is scored at the next test only, so a skip block gets none
        const block = (rows: BenchScoreRow[], againstLive: boolean = true) => {
            const sum: any = scoreSummary(rows, { flagsOf: flagsOf, minGapN: sc.minGapN });
            if (!againstLive) { sum.vsLive = { n: 0, note: 'not compared: the live projection is scored at the next test only' }; return sum; }
            const paired = rows.filter(r => liveByT.has(r.t) && !flagsOf(r).length);
            sum.vsLive = pairedDifference(paired.map(r => r.miss), paired.map(r => liveByT.get(r.t)));
            return sum;
        };
        const variants = s.variants.map(v => {
            const mine = all.filter(r => r.id === v.id && r.v === v.version);
            const pick = (replay: boolean, horizon: string, mode: string, days?: number) =>
                mine.filter(r => !!r.replay === replay && r.horizon === horizon && r.mode === mode && (!days || r.t >= now - days * DAY_MS));
            const headMode = v.kind === 'live' ? 'live' : 'nowcast';
            const liveNext = pick(false, 'next', headMode);
            // the band the variant would show at its next test: the 90% half-width of its own misses before it, as the app shows its range
            const fair = liveNext.filter(r => !flagsOf(r).length);
            const ownBand = fair.length >= 5 ? scoreSummary(fair.slice(-30)).halfWidth90 : undefined;
            return {
                id: v.id, version: v.version, label: v.label, kind: v.kind, retired: v.retired === true,
                live: { last90: block(pick(false, 'next', headMode, 90)), all: block(liveNext), forecast: block(pick(false, 'next', 'forecast')), skip: block(pick(false, 'skip', headMode), false) },
                replay: { next: block(pick(true, 'next', headMode)), forecast: block(pick(true, 'next', 'forecast')), skip: block(pick(true, 'skip', headMode), false) },
                // the revised hindcast (tuning only): the live rows that have one, scored with the corrected CYA path
                revised: (() => {
                    const r = liveNext.filter(x => typeof x.revisedMiss === 'number');
                    if (!r.length) return undefined;
                    const o = { flagsOf: flagsOf, minGapN: sc.minGapN };
                    return Object.assign(scoreSummary(r.map(x => Object.assign({}, x, { miss: x.revisedMiss })), o), { asScored: scoreSummary(r, o) });
                })(),
                ownBand: ownBand,
                lastMisses: liveNext.slice(-10).map(r => { const f = flagsOf(r); return { t: new Date(r.t).toISOString(), test: r.test, proj: r.proj, miss: r.miss, days: r.days, flags: f.length ? f : undefined }; })
            };
        });
        let coverage: any, stabilizer: any, cya: any;
        try {
            const inp = this.gatherInputs(now - 14 * DAY_MS, now);
            coverage = Object.assign(inputCoverage(inp.rows, now - 14 * DAY_MS, now), { weatherSource: !!weatherSource, waterTempSource: !!waterTempSource, pumpSource: !!pumpSource, place: typeof inp.sources.lat === 'number' });
            stabilizer = archivedStabilizerAdditions(inp.gallons).slice(-10).map(a => ({ ts: a.ts.toISOString(), grams: Math.round(a.grams), ppm: Math.round(a.ppm * 10) / 10 }));
        }
        catch (err) { coverage = { error: err && err.message }; }
        try { cya = this.cyaReport(120, false); }
        catch (err) { cya = { error: err && err.message }; }
        return {
            enabled: s.enabled, scoring: sc, lastCheck: this.lastCheck ? new Date(this.lastCheck).toISOString() : undefined, lastScored: this.lastScored ? new Date(this.lastScored).toISOString() : undefined,
            lastError: this.lastError, replay: this.replayState, coverage: coverage, stabilizerAdditions: stabilizer, cya: cya, variants: variants
        };
    }

    // The CYA path over the last `days` days as known now (every 6 hours, with `samples`), the tests and how the path took each, the additions, the
    // rain k, the advice, the recorded tests and the last drift checks.
    public cyaReport(days: number, samples: boolean = true): any {
        const now = Date.now();
        const d = Math.max(7, Math.min(400, Math.floor(days) || 120));
        const inp = this.gatherInputs(now - (d + 60) * DAY_MS, now);
        const p = inp.cyaPathAt(now);
        const from = now - d * DAY_MS;
        const iso = (t: number) => new Date(t).toISOString();
        const recorded = this.readRows<any>(CYA_FILE);
        return {
            settings: this.getSettings().cya, source: p.source, rainK: round(p.rainK, 4), defaultK: round(p.defaultK, 4), pairs: p.pairs,
            now: round(p.at(now), 1), anchor: p.anchor ? { t: iso(p.anchor.t), ppm: p.anchor.ppm } : undefined,
            tests: p.notes.filter(n => n.t >= from).map(n => Object.assign({}, n, { t: iso(n.t) })),
            additions: inp.cyaAdds.filter(a => a.t >= from).map(a => ({ t: iso(a.t), ppm: round(a.ppm, 1) })),
            advice: this.lastAdvice || state.autoSwg.benchCyaAdvice,
            records: recorded.filter(r => r.kind === 'test').slice(-10).map(r => Object.assign({}, r, { t: iso(r.t) })),
            drift: recorded.filter(r => r.kind === 'drift').slice(-4).map(r => Object.assign({}, r, { t: iso(r.t) })),
            path: samples ? pathSamples(p, from, now).map(x => [iso(x[0]), x[1]]) : undefined
        };
    }

    // ------------------------------------------------------------ the closed-loop simulator

    // Runs the simulator in the background: the live projection, the plain averages and each model variant feed the real range control, for `seeds`
    // seeds at a test rhythm, on the 'k' plant and (when there is sun) the model plant. One seed at a time, with a pause between.
    public async simulate(req: { rhythm?: SimRhythm; seeds?: number; days?: number; runWindow?: 'sun' | 'sunOffset' }): Promise<void> {
        if (this.simState.running) return;
        const rhythm: SimRhythm = req.rhythm === 'weekly' || req.rhythm === 'real' ? req.rhythm : 'twiceWeekly';
        const seeds = Math.max(1, Math.min(50, Math.floor(Number(req.seeds) || 20)));
        const days = Math.max(30, Math.min(400, Math.floor(Number(req.days) || 300)));
        this.simState = { running: true, request: { rhythm: rhythm, seeds: seeds, days: days, runWindow: req.runWindow || 'sun' }, done: 0, startedAt: Date.now() };
        try {
            const end = Math.floor(Date.now() / HOUR_MS) * HOUR_MS, start = end - days * DAY_MS;
            const inp = this.gatherInputs(start - 60 * DAY_MS, end);
            const cfg: any = sys.autoSwg;
            const loc: any = sys.general && sys.general.location;
            const swg = inp.sources.swgEntries.map(e => ({ t: e.ts, ppmPerDay: e.ppmPerDay, hrs: e.hrs, pct: e.pct }));
            const data: SimData = {
                start: start, end: end, lat: loc && typeof loc.latitude === 'number' ? loc.latitude : 28.5, lon: loc && typeof loc.longitude === 'number' ? loc.longitude : -81.5,
                fc: archivedFcReadings().map(r => ({ t: r.ts.getTime(), fc: r.value })), swg: swg,
                adds: inp.sources.chlorine.map(c => ({ t: c.ts, ppm: c.ppm })), rows: inp.rows, cya: inp.cya,
                ppmPerHourAtFull: poundsToPpm(inp.sources.cellLbsPerDay / 24, inp.gallons)
            };
            const settings = simSettingsFrom(cfg, req.runWindow);
            const cal = buildCalendar(data, settings);
            const s = this.getSettings();
            const projectors: Projector[] = [liveProjector()];
            for (const v of s.variants) {
                if (v.retired) continue;
                if (v.kind === 'plain') projectors.push(plainProjector(v.windowDays || 14));
                else if (v.kind === 'model' && inp.rows.some(r => typeof r.sun === 'number')) projectors.push(modelProjector(v));
            }
            const mainModel = s.variants.find(v => v.id === 'sun-cya-30' && !v.retired) || s.variants.find(v => v.kind === 'model' && !v.retired);
            const plants: { name: string; plant: any }[] = [{ name: 'k', plant: 'k' }];
            const mp = mainModel ? fitModelPlant(data, mainModel) : undefined;
            if (mp) plants.push({ name: 'model', plant: mp });
            this.simState.total = plants.length * projectors.length * seeds;
            const results: any = {};
            for (const p of plants) {
                results[p.name] = {};
                for (const pr of projectors) {
                    const list: SimOutcome[] = [];
                    for (let k = 0; k < seeds; k++) {
                        const sd = 1000 + k;
                        list.push(outcome(simulate(data, cal, settings, pr, testsFor(rhythm, sd, data), sd, p.plant), settings));
                        this.simState.done++;
                        await pause(PAUSE_MS);
                    }
                    results[p.name][pr.name] = summarizeOutcomes(list);
                }
            }
            this.simState.results = results;
        }
        catch (err) { this.simState.error = err && err.message; logger.warn(`SWG Assist bench: simulation failed: ${err && err.message}`); }
        finally { this.simState.running = false; this.simState.finishedAt = Date.now(); }
    }
    public simStatus(): any { return this.simState; }
}

// The local 10:00 or 22:00 at or before t (the automatic checks' times).
export function lastCheckBefore(t: number): number {
    const d = new Date(t);
    for (let k = 0; k < 3; k++) {
        const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - k);
        for (const h of [22, 10]) { const c = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime(); if (c < t) return c; }
    }
    return t - DAY_MS;
}

// The simulator's range-control settings from SWG Assist's settings (the defaults where one is not set).
export function simSettingsFrom(cfg: any, runWindow?: 'sun' | 'sunOffset'): SimSettings {
    const s: SimSettings = Object.assign({}, DEFAULT_SIM_SETTINGS, { cycle: Object.assign({}, DEFAULT_SIM_SETTINGS.cycle) });
    const num = (x: any) => typeof x === 'number' && isFinite(x);
    if (cfg) {
        if (num(cfg.fcLow)) s.low = cfg.fcLow;
        if (num(cfg.fcHigh)) s.high = cfg.fcHigh;
        if (num(cfg.windowDays) && cfg.windowDays > 0) s.windowDays = cfg.windowDays;
        if (num(cfg.projectionWeight)) s.projectionWeight = cfg.projectionWeight;
        if (num(cfg.bandBiasPerDay)) s.biasPerDay = cfg.bandBiasPerDay;
        if (num(cfg.overshootPpmPerDay)) s.overshootPpmPerDay = cfg.overshootPpmPerDay;
        if (typeof cfg.bandPeakCap === 'boolean') s.peakCap = cfg.bandPeakCap;
        if (typeof cfg.bandIntegral === 'boolean') s.integral = cfg.bandIntegral ? 0.3 : 0;
        if (typeof cfg.bandScaledBias === 'boolean') s.scaledBias = cfg.bandScaledBias;
    }
    if (runWindow) s.runWindow = runWindow;
    return s;
}

export const autoSwgBench = new AutoSwgBench();
