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

// The Model Bench's water balance for the dashboard's History panel (controller/History.ts), stored the way SWG Assist stores its projection: each
// check's run (data/autoSwgBenchChem.jsonl) is its own line (seg), beside PoolMath's own tests.
//   swgBench:phProjection   the pH projected from the last pH test, 7 days ahead          line, future, seg = run    view pH
//   swgBench:csiProjection  the CSI on that pH                                              line, future, seg = run    view CSI
//   swgBench:taPath         the TA between tests (less each acid dose)                      line, future, seg = run    view TA
//   swgBench:cyaPath        the CYA path as known now (TFP's loss, dilution, stabilizer)    line, future               view CYA
//   swgBench:phBand         the levels acid is recommended and needed at                    band                       view pH
//   swgBench:csiBand        TFP's CSI target for SWG pools, -0.3 to 0.0                     band                       view CSI
//   swgBench:acidAdvice     each run that advised acid, with its dose                       markers                    view pH
//   swgBench:fc:<variant>   each check's FC projection by a variant that uses the weather   line, future, seg = run    view FC
//                           (from the last reading, then 3 days ahead on the saved forecast), beside SWG Assist's Projected FC
// The registry is on the branches with the History panel; this file only describes the shape it expects, and registerBenchHistorySource does
// nothing where there is no registry.

import { logger } from '../logger/Logger';
import { sys } from './Equipment';
// the bench is loaded when the source is first asked, so the pure helpers below can be tested on their own
const bench = (): any => require('./AutoSwgBench').autoSwgBench;
import { pathSamples } from './AutoSwgBenchCya';

type Style = 'line' | 'band' | 'steps' | 'dots' | 'markers';
export interface BenchHistoryKind { kind: string; name: string; unit: string; group: string; style: Style; future?: boolean; view?: string; }
export interface BenchHistoryPoint { t: number; v?: number; lo?: number; hi?: number; text?: string; seg?: number; }
const DAY_MS = 86400000;
const GROUP = 'water balance';
export const TFP_SWG_CSI = { lo: -0.3, hi: 0 };

// The runs' points of one field (1 pH, 2 CSI, 3 TA, 4 CYA in each [t, ph, csi, ta, cya]) within [from, to], each run its own line.
export function runPointsOf(runs: any[], field: number, from: number, to: number): BenchHistoryPoint[] {
    const out: BenchHistoryPoint[] = [];
    for (const r of runs || []) {
        if (!r || !Array.isArray(r.points)) continue;
        for (const p of r.points) {
            if (!Array.isArray(p) || typeof p[0] !== 'number' || p[0] < from || p[0] > to) continue;
            const v = p[field];
            if (typeof v === 'number' && isFinite(v)) out.push({ t: p[0], v: v, seg: r.run });
        }
    }
    return out;
}
// The runs that advised acid, as markers at the run's time: the level, the dose and why.
export function advicePointsOf(runs: any[], from: number, to: number): BenchHistoryPoint[] {
    return (runs || []).filter(r => r && r.advice && typeof r.run === 'number' && r.run >= from && r.run <= to).map(r => {
        const a = r.advice;
        const what = a.level === 'needed' ? 'Acid needed' : 'Acid recommended';
        const dose = typeof a.doseFlOz === 'number' && a.doseFlOz > 0 ? `: ${a.doseFlOz} fl oz to ${a.doseTo}` : '';
        const first = Array.isArray(r.points) ? r.points.find((p: any[]) => p[0] >= r.run) : undefined;
        return { t: r.run, v: first && typeof first[1] === 'number' ? first[1] : undefined, text: a.text ? `${what}: ${a.text}` : `${what}${dose}. ${a.reason || ''}`.trim() };
    });
}

// The logged FC projection runs as points within [from, to], each run its own line.
export function fcRunPoints(runs: any[], from: number, to: number): BenchHistoryPoint[] {
    const out: BenchHistoryPoint[] = [];
    for (const r of runs || []) {
        if (!r || !Array.isArray(r.points)) continue;
        for (const p of r.points) if (Array.isArray(p) && p[0] >= from && p[0] <= to && typeof p[1] === 'number') out.push({ t: p[0], v: p[1], seg: r.run });
    }
    return out;
}

export const benchHistorySource = {
    id: 'swgBench', name: 'SWG Assist Model Bench',
    kinds(): BenchHistoryKind[] {
        if (!sys.autoSwg.shareCode || !bench().getSettings().enabled) return [];
        const fixed: BenchHistoryKind[] = [
            { kind: 'phProjection', name: 'Projected pH', unit: '', group: GROUP, style: 'line', future: true, view: 'pH' },
            { kind: 'phBand', name: 'Acid Recommended to Needed pH', unit: '', group: GROUP, style: 'band', view: 'pH' },
            { kind: 'acidAdvice', name: 'Acid Advice', unit: '', group: GROUP, style: 'markers', view: 'pH' },
            { kind: 'csiProjection', name: 'Projected CSI', unit: '', group: GROUP, style: 'line', future: true, view: 'CSI' },
            { kind: 'csiBand', name: 'TFP SWG CSI Target', unit: '', group: GROUP, style: 'band', view: 'CSI' },
            { kind: 'taPath', name: 'TA Between Tests', unit: 'ppm', group: GROUP, style: 'line', future: true, view: 'TA' },
            { kind: 'cyaPath', name: 'CYA Path', unit: 'ppm', group: GROUP, style: 'line', future: true, view: 'CYA' }
        ];
        return fixed.concat(bench().fcVariants().map((v: any): BenchHistoryKind => ({ kind: `fc:${v.id}`, name: `Bench FC: ${v.label || v.id}`, unit: "ppm", group: "fc", style: "line", future: true, view: "FC" })));
    },
    series(kinds: string[], from: number, to: number): { [kind: string]: BenchHistoryPoint[] } {
        const out: { [kind: string]: BenchHistoryPoint[] } = {};
        if (!sys.autoSwg.shareCode) return out;
        const want = (k: string) => kinds.indexOf(k) !== -1;
        const runs = want('phProjection') || want('csiProjection') || want('taPath') || want('acidAdvice') ? bench().chemRuns(from, to) : [];
        if (want('phProjection')) out.phProjection = runPointsOf(runs, 1, from, to);
        if (want('csiProjection')) out.csiProjection = runPointsOf(runs, 2, from, to);
        if (want('taPath')) out.taPath = runPointsOf(runs, 3, from, to);
        if (want('acidAdvice')) out.acidAdvice = advicePointsOf(runs, from, to);
        const s = bench().getSettings().chem;
        if (want('phBand')) out.phBand = [{ t: from, lo: s.phRecommended, hi: s.phNeeded }, { t: to, lo: s.phRecommended, hi: s.phNeeded }];
        if (want('csiBand')) out.csiBand = [{ t: from, lo: TFP_SWG_CSI.lo, hi: TFP_SWG_CSI.hi }, { t: to, lo: TFP_SWG_CSI.lo, hi: TFP_SWG_CSI.hi }];
        for (const k of kinds) {
            if (k.indexOf('fc:') !== 0) continue;
            out[k] = fcRunPoints(bench().fcRuns(k.slice(3), from, to), from, to);
        }
        if (want('cyaPath')) {
            const now = Date.now();
            const cfg: any = sys.autoSwg;
            const p = bench().cyaInputs(cfg.gallons > 0 ? cfg.gallons : 0, now).pathAt(now);
            const step = to - from > 60 * DAY_MS ? 24 : 6;
            out.cyaPath = pathSamples(p, from, Math.min(to, now + 7 * DAY_MS), step).map(x => ({ t: x[0], v: x[1] }));
        }
        return out;
    }
};

// Registers the source with the History panel's registry where this build has one (the branches with controller/History.ts); elsewhere nothing.
let registered = false;
export function registerBenchHistorySource() {
    if (registered) return;
    registered = true;
    let history: any;
    try { history = require('./History'); }
    catch (err) { return; }
    try { if (history && history.historyRegistry) history.historyRegistry.register(benchHistorySource); }
    catch (err) { logger.warn(`SWG Assist bench: could not register its history: ${err && err.message}`); }
}
