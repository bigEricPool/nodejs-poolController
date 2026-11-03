// What SWG Assist was steering FC to over time, for the bars of the Water panel's FC view: a list of steps, each holding from its `t` until the next one's.
//   { t, low, high }  a range in force (range control, Away protection off)
//   { t, target }     a single target (target control, or Away protection's vacation target while Away is on)
//   { t }             no target (SWG Assist off, or before its history starts)
// It is rebuilt from the settings records of the history (what changed, from and to), so a setting that was never changed holds its current value all along.
// Range control arrived with a default and not with a settings save, so when it began is told by rangeSince().
import { AutoSwgHistoryRecord, AutoSwgSettingChange } from './AutoSwgHistory';

export interface AutoSwgStep { t: number; low?: number; high?: number; target?: number; }

export interface AutoSwgStepSettings { enabled: boolean; controlMode: string; fcLow: number; fcHigh: number; targetFc: number; awayEnabled: boolean; awayTargetFc: number; }

const TRACKED = ['enabled', 'controlMode', 'fcLow', 'fcHigh', 'targetFc', 'awayEnabled', 'awayTargetFc'];

// When range control began: the earlier of the time the setting first existed (AutoSwg.controlModeSince) and the first history record written by algorithm
// version 3 or later. Undefined when neither is known, in which case range control is taken to have been in force all along.
export function rangeSince(records: AutoSwgHistoryRecord[], controlModeSince?: string): number | undefined {
    let since: number | undefined;
    const take = (t: number) => { if (isFinite(t) && (typeof since === 'undefined' || t < since)) since = t; };
    if (controlModeSince) take(new Date(controlModeSince).getTime());
    for (const r of records) if (typeof r.algorithm === 'number' && r.algorithm >= 3) take(new Date(r.appliedAt).getTime());
    return since;
}

export function buildSteps(records: AutoSwgHistoryRecord[], current: AutoSwgStepSettings, fromMs: number, nowMs: number, rangeSinceMs?: number): AutoSwgStep[] {
    const settingsRecs = records.filter(r => r.source === 'settings' && r.changes && r.changes.length)
        .map(r => ({ t: new Date(r.appliedAt).getTime(), changes: r.changes as AutoSwgSettingChange[] }))
        .filter(r => isFinite(r.t));
    // The history starts at its earliest record of any kind; before that there is nothing to say.
    let historyStart = Infinity;
    for (const r of records) { const t = new Date(r.appliedAt).getTime(); if (isFinite(t) && t < historyStart) historyStart = t; }

    // Before the first change of a setting it held the value that change replaced; a setting never changed holds its current value.
    const val: { [k: string]: any } = {};
    for (const k of TRACKED) {
        val[k] = (current as any)[k];
        let first: { t: number; from: any } | undefined;
        for (const r of settingsRecs) {
            const c = r.changes.find(x => x.setting === k);
            if (c && (!first || r.t < first.t)) first = { t: r.t, from: c.from };
        }
        if (first) val[k] = first.from;
    }

    // Before range control the only control was the target, and it began with the default, 'band'.
    const ranged = typeof rangeSinceMs === 'number';
    if (ranged) val.controlMode = 'target';

    interface Ev { t: number; order: number; apply: () => void; }
    const events: Ev[] = [];
    if (ranged) events.push({ t: rangeSinceMs as number, order: 0, apply: () => { val.controlMode = 'band'; } });
    if (isFinite(historyStart)) events.push({ t: historyStart, order: 0, apply: () => { /* only so a step is cut here */ } });
    for (const r of settingsRecs) {
        events.push({ t: r.t, order: 1, apply: () => {
            for (const c of r.changes) if (TRACKED.indexOf(c.setting) >= 0) val[c.setting] = c.to;
        } });
    }
    events.sort((a, b) => a.t - b.t || a.order - b.order);

    const stepOf = (t: number): AutoSwgStep => {
        if (t < historyStart || val.enabled === false) return { t: t };
        if (val.awayEnabled === true) return { t: t, target: Number(val.awayTargetFc) };
        if (val.controlMode === 'band') return { t: t, low: Number(val.fcLow), high: Number(val.fcHigh) };
        return { t: t, target: Number(val.targetFc) };
    };
    const same = (a: AutoSwgStep, b: AutoSwgStep) => a.low === b.low && a.high === b.high && a.target === b.target;

    const out: AutoSwgStep[] = [];
    const push = (s: AutoSwgStep) => { if (!out.length || !same(out[out.length - 1], s)) out.push(s); };
    let i = 0;
    while (i < events.length && events[i].t <= fromMs) { events[i].apply(); i++; }
    push(stepOf(fromMs));
    for (; i < events.length && events[i].t <= nowMs; i++) { events[i].apply(); push(stepOf(events[i].t)); }
    return out;
}
