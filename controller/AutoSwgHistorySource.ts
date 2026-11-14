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
import { sys } from "./Equipment";
import { HistoryKind, HistoryPoint, HistorySource } from "./History";
import { projectionLog, ProjectionPoint } from "./AutoSwgProjection";
import { AutoSwgStep, buildSteps, rangeSince } from "./AutoSwgSteps";
import { readAutoSwgHistory } from "./AutoSwgHistory";

// SWG Assist's history for the dashboard's History panel (see History.ts), the same data as GET /state/autoSwg/fc:
//   swgAssist:projection  the FC SWG Assist projected, a line through each value it calculated; each calculation run is its own line (seg)
//   swgAssist:range       the FC range (or single target) it steered to at each time, a band that steps where a setting changed
// Both start in the FC view, beside the PoolMath FC tests. Offered only while SWG Assist has a PoolMath share code.
const DAY_MS = 86400000;

export function projectionPointsOf(points: ProjectionPoint[], from: number, to: number): HistoryPoint[] {
    return points.filter(p => p && typeof p.t === 'number' && typeof p.fc === 'number' && isFinite(p.fc) && p.t >= from && p.t <= to)
        .map(p => ({ t: p.t, v: p.fc, seg: p.run }));
}
// A range is lo to hi, a single target a band of no width, and no target a point without either (the band before it ends there).
export function rangePointsOf(steps: AutoSwgStep[]): HistoryPoint[] {
    return steps.filter(s => s && typeof s.t === 'number').map(s => {
        const ok = (v: any) => typeof v === 'number' && isFinite(v);
        if (ok(s.low) && ok(s.high)) return { t: s.t, lo: Math.min(s.low, s.high), hi: Math.max(s.low, s.high) };
        if (ok(s.target)) return { t: s.t, lo: s.target, hi: s.target };
        return { t: s.t };
    });
}

export const autoSwgHistorySource: HistorySource = {
    id: 'swgAssist', name: 'SWG Assist',
    kinds(): HistoryKind[] {
        if (!sys.autoSwg.shareCode) return [];
        return [
            { kind: 'projection', name: 'Projected FC', unit: 'ppm', group: 'fc', style: 'line', future: true, view: 'FC' },
            { kind: 'range', name: 'FC Range', unit: 'ppm', group: 'fc', style: 'band', view: 'FC' }
        ];
    },
    series(kinds: string[], from: number, to: number) {
        const out: { [kind: string]: HistoryPoint[] } = {};
        if (!sys.autoSwg.shareCode) return out;
        const now = Date.now();
        if (kinds.indexOf('projection') !== -1) {
            const days = Math.min(1461, Math.max(1, Math.ceil((now - from) / DAY_MS) + 1));
            out.projection = projectionPointsOf(projectionLog.read(days), from, to);
        }
        if (kinds.indexOf('range') !== -1) {
            const cfg = sys.autoSwg;
            const history = readAutoSwgHistory();
            const steps = buildSteps(history, { enabled: cfg.enabled, controlMode: cfg.controlMode, fcLow: cfg.fcLow, fcHigh: cfg.fcHigh, targetFc: cfg.targetFc, awayEnabled: cfg.awayEnabled, awayTargetFc: cfg.awayTargetFc },
                from, now, rangeSince(history, cfg.controlModeSince));
            out.range = rangePointsOf(steps);
        }
        return out;
    }
};
