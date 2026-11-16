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

// Persistent log of SWG % changes on the SWG Assist chlorinator. A record is written
// (a) each time a recommendation is applied, capturing the inputs and outputs of
// the calculation behind it, and (b) each time the pool setpoint is changed some
// other way (API, socket, MQTT, the panel), with just the capacity inputs needed
// to interpret it. AutoSwgService merges these records with PoolMath's SWG log
// entries and prefers the local ones (see mergeSwgEvents there), so the
// calculation reflects what was actually set even if the change was never logged
// on PoolMath.
//
// Stored one record per line in data/autoSwgHistory.jsonl (next to poolConfig.json,
// which -- unlike the logs/ folder -- is not rotated away), and kept in memory once
// loaded; see AutoSwgHistoryLog. Records older than AUTO_SWG_HISTORY_MONTHS are pruned
// about once a month. Until 2026-11 it was a JSON array in data/autoSwgHistory.json,
// which is moved over once and then left in place, unchanged.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import type { LocalSwgEntry } from './AutoSwgService';

export const AUTO_SWG_HISTORY_MONTHS = 48;

// What caused an SWG Assist apply: the periodic check, the Refresh and Apply button, Check Now or Refresh: Adjust % with
// Auto-Apply on, a person pressing Apply after reviewing the number, or the step to the maintenance % after a target.
export type AutoSwgApplyTrigger = 'automatic-check' | 'refresh-and-apply' | 'check-now' | 'refine' | 'reviewed' | 'step';

// One SWG Assist setting that was changed, with its old and new value.
export interface AutoSwgSettingChange { setting: string; from: any; to: any; }

// Bump this when the calculation itself changes in a way that can change its numbers (not for settings or display), so
// the history shows which version of the algorithm produced each apply. 1 = before the projection weighting and taper,
// 2 = weighting and taper, the PoolMath archive and the liquid chlorine credit, 3 = range control (SwgAssistBand.ts) in place of the single target
// in normal operation (records written while the control mode is 'target' or Away protection is on are made by the same rules as version 2).
export const AUTO_SWG_ALGORITHM_VERSION = 3;

// The settings whose changes are logged. A change to the target, the days to reach it or the tuning options is what to
// line up against the FC history when judging how the calculation did.
export const AUTO_SWG_LOGGED_SETTINGS = [
    'enabled', 'chlorinatorId', 'gallons', 'swgLbsPerDay', 'swgStartTime', 'swgStopTime', 'scheduleId', 'timezone',
    'controlMode', 'fcLow', 'fcHigh', 'bandBiasPerDay', 'bandBoostPeriods', 'bandPeakCap', 'bandIntegral', 'bandScaledBias', 'targetFc', 'targetPeriodsAbove', 'targetPeriodsBelow', 'newTargetDateThresholdPpm', 'autoStepEnabled',
    'autoApplyEnabled', 'autoCheckEnabled', 'autoCheckHours', 'autoCheckStartTime', 'autoApplyWarnThresholdPct',
    'windowDays', 'daytimeLossSharePct', 'creditChlorineAdditions', 'fcAnomalyTolerancePpm',
    'projectionWeight', 'projectionTaperStartDays', 'projectionTaperEndDays', 'overshootPpmPerDay', 'protectOvernightLow', 'nightBurnRatio', 'burnTempAdjust',
    'mode', 'autoTuneEnabled', 'autoTuneAfterFcReadings', 'autoTuneApplyEnabled', 'autoTuneApplyAfterManual',
    'stormResponseEnabled', 'stormMaxExtraPct', 'stormMaxDays', 'awayEnabled', 'awayTargetFc', 'awayMaintMultiplier',
    'shareCode', 'poolName'
];
// Logged as "changed" only: the values are private, but a different pool's data changes everything after it.
const AUTO_SWG_MASKED_SETTINGS = ['shareCode', 'poolName'];

export interface AutoSwgHistoryRecord {
    source: 'auto' | 'manual' | 'settings'; // 'auto' = applied via SWG Assist; 'manual' = changed some other way; 'settings' = SWG Assist settings were changed (see `changes`)
    changes?: AutoSwgSettingChange[]; // settings only: what changed
    via?: 'tune' | 'auto-tune' | 'away-ended'; // settings only: the change was applied from the Tune dialog, or by auto tune
    algorithm?: number;       // AUTO_SWG_ALGORITHM_VERSION when this was written (absent on older records)
    trigger?: AutoSwgApplyTrigger; // auto only: what caused it (absent on records written before this was kept)
    // auto only: what this apply did with the target date. 'kept' = refreshed against the original deadline; 'new' = a new
    // target was started; 'new-extended' = a new target whose deadline was then moved out to when consumption alone reaches
    // the target FC. Absent on records written before this was kept, and on steps.
    targetOutcome?: 'kept' | 'new' | 'new-extended';
    targetFc?: number;
    targetDate?: string;           // ISO: the deadline this apply is aiming for
    previousTargetDate?: string;   // ISO: the in-flight deadline before this apply, if there was one
    targetStrayPpm?: number;       // how far the projected FC was from the target FC when this apply decided kept or new
    targetThresholdPpm?: number;   // the new-target-date threshold in force then (unset for Check Now, which has no in-flight target)
    runWindowChange?: { from: string; to: string };   // set when the run window differs from the previous apply's (to the nearest 10 minutes), for example "08:20-18:09" to "09:20-17:09"
    appliedAt: string;        // ISO time the setpoint was sent (auto) or the change was detected (manual)
    appliedPct?: number;      // the SWG % now in effect (not set on a settings record)
    recommendedPct?: number;  // auto only: what the calculation recommended (differs from appliedPct if overridden)
    previousPct?: number;     // the SWG % before this change
    ppmPerDay?: number;       // appliedPct x window capacity; PoolMath-style "X ppm FC" equivalent
    hrs?: number;             // run-window length used for ppmPerDay
    away?: any;               // settings only, when Away protection ended: a summary of the period (see awaySummary in web/services/state/State.ts)
    inputs?: any;             // the calculation's parameters (auto) or the capacity inputs (manual)
    outputs?: any;            // auto only: the calculation's results as of apply (see AutoSwgState)
}

// How long past the 48-month cutoff the oldest record may be before the file is rewritten without the expired ones. Pruning
// a month at a time means a rewrite about once a month once the log is that old, not one a day.
const PRUNE_SLACK_MS = 30 * 86400000;
const PRUNE_CHECK_EVERY_MS = 86400000;

function cutoffOf(now: Date): number {
    const cutoff = new Date(now.getTime());
    cutoff.setMonth(cutoff.getMonth() - AUTO_SWG_HISTORY_MONTHS);
    return cutoff.getTime();
}

function pruneOld(records: AutoSwgHistoryRecord[], now: Date): AutoSwgHistoryRecord[] {
    const cutoff = cutoffOf(now);
    return records.filter(r => {
        const t = new Date(r.appliedAt).getTime();
        return !isNaN(t) && t >= cutoff;
    });
}

function isRecord(x: any): x is AutoSwgHistoryRecord { return !!x && typeof x === 'object' && !Array.isArray(x); }

function linesOf(records: AutoSwgHistoryRecord[]): string { return records.map(r => JSON.stringify(r) + '\n').join(''); }

// The history log. It is loaded from the file once and then kept in memory; a record is added with one append of one line,
// so nothing is rewritten when a record is added (the old JSON array was rewritten in full, and parsed in full on every read,
// which stalled the event loop longer as it grew). Each read checks the file's size and modified time and loads it again if
// something else changed it (a restore, an edit by hand).
//
// The first time it runs where only the old data/autoSwgHistory.json exists, the records are copied into the new file, checked
// by reading them back, and the old file is left where it is, unchanged: an older njsPC started on this data folder still finds
// the history up to the move (it misses only the records written since). Nothing here deletes it. If the old file can't be read
// or the copy fails, no new file is made and that run keeps using the old file the old way, so a failure never starts an empty log.
export class AutoSwgHistoryLog {
    private records: AutoSwgHistoryRecord[] | undefined;
    private legacy = false;        // the move failed: this run reads and writes the old JSON array, as before
    private legacyUnreadable = false;
    private stamp = '';            // size and modified time of the file when it was last read or written
    private needsNewline = false;  // the file's last line was cut short (a power loss): the next append starts on a new line
    private lastPruneCheck = 0;
    constructor(private readonly dir: () => string) { }
    file(): string { return path.join(this.dir(), 'autoSwgHistory.jsonl'); }
    legacyFile(): string { return path.join(this.dir(), 'autoSwgHistory.json'); }

    // The records, oldest first. The array is a copy, so a caller may filter or sort it; the records themselves are shared.
    read(): AutoSwgHistoryRecord[] {
        this.ensureLoaded();
        return this.records.slice();
    }

    append(record: AutoSwgHistoryRecord): AutoSwgHistoryRecord[] {
        this.ensureLoaded();
        if (this.legacy) return this.appendLegacy(record);
        const file = this.file();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, (this.needsNewline ? '\n' : '') + JSON.stringify(record) + '\n', 'utf8');
        this.needsNewline = false;
        this.records.push(record);
        this.stamp = this.statStamp(file);
        this.pruneIfDue(new Date());
        return this.records.slice();
    }

    private statStamp(file: string): string {
        try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; }
        catch (err) { return ''; }
    }

    private ensureLoaded() {
        if (this.legacy) { this.records = this.readLegacy(); return; }
        if (this.records && this.statStamp(this.file()) === this.stamp) return;
        this.load();
    }

    private load() {
        const file = this.file();
        let text: string | undefined;
        try { text = fs.readFileSync(file, 'utf8'); }
        catch (err) {
            if (!err || err.code !== 'ENOENT') logger.warn(`SWG Assist: could not read ${file}: ${err.message}`);
        }
        if (typeof text === 'undefined') {
            if (this.migrate()) return;
            this.records = [];
            this.stamp = '';
            this.needsNewline = false;
            return;
        }
        const records: AutoSwgHistoryRecord[] = [];
        let skipped = 0;
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const r = JSON.parse(line);
                if (isRecord(r)) records.push(r); else skipped++;
            }
            catch (err) { skipped++; }   // a line cut short by a power loss
        }
        if (skipped) logger.warn(`SWG Assist: skipped ${skipped} unreadable line(s) in ${file}`);
        this.records = records;
        this.needsNewline = text.length > 0 && !text.endsWith('\n');
        this.stamp = this.statStamp(file);
    }

    // Copies the old JSON array into the new file. Returns true when this run should go on (moved, or nothing to move and the
    // new file is to be started), false when there was no old file. On a failure it switches this run to the old file.
    private migrate(): boolean {
        const from = this.legacyFile(), to = this.file();
        let text: string;
        try { text = fs.readFileSync(from, 'utf8'); }
        catch (err) {
            if (err && err.code === 'ENOENT') return false;
            return this.migrationFailed(`could not read ${from}: ${err.message}`, false);
        }
        let parsed: any;
        try { parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); }
        catch (err) { return this.migrationFailed(`${from} is not valid JSON (${err.message})`, true); }
        if (!Array.isArray(parsed)) return this.migrationFailed(`${from} is not a list of records`, true);
        const records = parsed.filter(isRecord);
        const tmp = `${to}.tmp`;
        try {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.writeFileSync(tmp, linesOf(records), 'utf8');
            const back = fs.readFileSync(tmp, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
            if (back.length !== records.length) throw new Error(`read back ${back.length} of ${records.length} records`);
            fs.renameSync(tmp, to);
        }
        catch (err) {
            try { fs.unlinkSync(tmp); } catch (e) { /* not there */ }
            return this.migrationFailed(`could not write ${to}: ${err.message}`, false);
        }
        logger.info(`SWG Assist: history moved to ${to} (${records.length} records); ${from} is left in place, unchanged`);
        this.records = records;
        this.needsNewline = false;
        this.stamp = this.statStamp(to);
        return true;
    }

    private migrationFailed(why: string, unreadable: boolean): boolean {
        logger.error(`SWG Assist: the history was NOT moved to the new log: ${why}. This run keeps using the old file; the move is tried again at the next start.`);
        this.legacy = true;
        this.legacyUnreadable = unreadable;
        this.records = this.readLegacy();
        return true;
    }

    // The old way, used only after a failed move: the whole JSON array, read and written in full.
    private readLegacy(): AutoSwgHistoryRecord[] {
        if (this.legacyUnreadable) return [];
        try {
            const text = fs.readFileSync(this.legacyFile(), 'utf8');
            const parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
            return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
        }
        catch (err) {
            if (err && err.code !== 'ENOENT') logger.warn(`SWG Assist: could not read ${this.legacyFile()}: ${err.message}`);
            return [];
        }
    }

    private appendLegacy(record: AutoSwgHistoryRecord): AutoSwgHistoryRecord[] {
        if (this.legacyUnreadable) {
            // Writing would replace history that can't be read with only the new record: keep the file as it is and say so.
            logger.error(`SWG Assist: a history record was not saved, because ${this.legacyFile()} can't be read and is not overwritten (${record.source} at ${record.appliedAt})`);
            return [];
        }
        const records = pruneOld([...this.readLegacy(), record], new Date());
        const file = this.legacyFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
        fs.renameSync(tmp, file);
        this.records = records;
        return records.slice();
    }

    // At most once a day: when the oldest record is more than PRUNE_SLACK_MS past the cutoff, rewrites the file without the
    // expired records (through a temporary file and a rename).
    private pruneIfDue(now: Date) {
        if (now.getTime() - this.lastPruneCheck < PRUNE_CHECK_EVERY_MS) return;
        this.lastPruneCheck = now.getTime();
        const cutoff = cutoffOf(now);
        const due = this.records.some(r => {
            const t = new Date(r.appliedAt).getTime();
            return isNaN(t) || t < cutoff - PRUNE_SLACK_MS;
        });
        if (!due) return;
        const kept = pruneOld(this.records, now);
        const file = this.file(), tmp = `${file}.tmp`;
        try {
            fs.writeFileSync(tmp, linesOf(kept), 'utf8');
            fs.renameSync(tmp, file);
        }
        catch (err) {
            logger.warn(`SWG Assist: could not prune ${file}: ${err.message}`);
            return;
        }
        logger.info(`SWG Assist: pruned ${this.records.length - kept.length} history record(s) older than ${AUTO_SWG_HISTORY_MONTHS} months`);
        this.records = kept;
        this.needsNewline = false;
        this.stamp = this.statStamp(file);
    }
}

const historyLog = new AutoSwgHistoryLog(() => path.join(process.cwd(), 'data'));

export function readAutoSwgHistory(): AutoSwgHistoryRecord[] {
    try { return historyLog.read(); }
    catch (err) {
        logger.warn(`SWG Assist: could not read the history: ${err.message}`);
        return [];
    }
}

// Appends `record` to the history log (see AutoSwgHistoryLog) and returns the whole history.
export function appendAutoSwgHistory(record: AutoSwgHistoryRecord): AutoSwgHistoryRecord[] {
    return historyLog.append(record);
}

// Reads the logged settings off an SWG Assist config object (anything with those properties).
export function snapshotAutoSwgSettings(cfg: any): { [setting: string]: any } {
    const snap: { [setting: string]: any } = {};
    for (const k of AUTO_SWG_LOGGED_SETTINGS) snap[k] = cfg ? cfg[k] : undefined;
    return snap;
}

// Logs the settings that differ between two snapshots as one 'settings' record. Nothing is written when none differ
// (saving the same values again is not a change).
export function logAutoSwgSettingChanges(before: { [setting: string]: any }, after: { [setting: string]: any }, via?: 'tune' | 'auto-tune' | 'away-ended', away?: any): void {
    const changes: AutoSwgSettingChange[] = [];
    for (const k of AUTO_SWG_LOGGED_SETTINGS) {
        if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
        const masked = AUTO_SWG_MASKED_SETTINGS.indexOf(k) >= 0;
        changes.push({ setting: k, from: masked ? '(hidden)' : before[k], to: masked ? '(hidden)' : after[k] });
    }
    if (changes.length === 0) return;
    const record: AutoSwgHistoryRecord = { source: 'settings', appliedAt: new Date().toISOString(), algorithm: AUTO_SWG_ALGORITHM_VERSION, changes: changes };
    if (via) record.via = via;
    if (away) record.away = away;
    appendAutoSwgHistory(record);
}

// The records that carry enough data to stand in for a PoolMath SWG log entry.
export function toLocalSwgEntries(records: AutoSwgHistoryRecord[]): LocalSwgEntry[] {
    const entries: LocalSwgEntry[] = [];
    for (const r of records) {
        if (typeof r.ppmPerDay !== 'number' || typeof r.hrs !== 'number' || typeof r.appliedPct !== 'number') continue;
        entries.push({ ts: r.appliedAt, ppmPerDay: r.ppmPerDay, hrs: r.hrs, pct: r.appliedPct, kind: r.source === 'manual' ? 'manual' : 'auto', record: r });
    }
    return entries;
}
