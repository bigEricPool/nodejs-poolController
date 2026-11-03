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

// What a read of the PoolMath share page says about the recent readings, merged into the pool's PoolMath archive (PoolMathArchive.ts). The page
// is parsed by AutoSwgService, so this merge belongs to SWG Assist; the archive itself is the logging layer's.
import { POOLMATH_LIQUID_CHLORINE, POOLMATH_SWG_CHEMICAL, PoolMathArchiveEntry, isChlorineEntry, isSwgEntry, readPoolMathArchive, writePoolMathArchive } from './PoolMathArchive';
import type { PageReadings } from './AutoSwgService';

// PoolMath entries can be edited or deleted, so the share page -- the freshest read there is -- wins
// for the period it covers. Given a read of the page, the archived test readings from the page's
// oldest entry onward are made to match it: values are updated (an edit), readings the page
// no longer lists are removed (a deletion), and readings the archive hasn't got yet are added.
// Older archive entries aren't touched (only recent entries are likely to be edited), and the other
// numbers on a test log (pH, salt, water temp, weather, ...) are kept. Does nothing unless the
// archive has already been pulled for this share code and pool -- the page never creates it.
export function refreshPoolMathArchiveFromPage(shareCode: string, poolName: string | undefined, page: PageReadings): { updated: number; added: number; removed: number } | undefined {
    if (!page.coverageStart) return undefined;
    const archive = readPoolMathArchive();
    if (!archive.syncedAt || archive.shareCode !== shareCode || (archive.poolName || '') !== (poolName || '')) return undefined;
    const MATCH_MS = 2 * 60 * 1000; // the page and the JSON can differ slightly in a log's timestamp
    const start = page.coverageStart.getTime();

    const groups = new Map<number, { ts: Date; fc?: number; cc?: number; cya?: number }>();
    const put = (list: { ts: Date; value: number }[], key: 'fc' | 'cc' | 'cya') => {
        for (const r of list) {
            const k = r.ts.getTime();
            const g = groups.get(k) || { ts: r.ts };
            (g as any)[key] = r.value;
            groups.set(k, g);
        }
    };
    put(page.fc, 'fc'); put(page.cc, 'cc'); put(page.cya, 'cya');

    // Archived test logs the page can speak for: in its span, and carrying FC/CC/CYA (a log
    // with none of those, e.g. a pH-only test, doesn't appear in what the page parses).
    const hasPageFields = (e: PoolMathArchiveEntry) => e.type === 'testlog' && (typeof e.fc === 'number' || typeof e.cc === 'number' || typeof e.cya === 'number');
    const candidates = archive.entries.filter(e => hasPageFields(e) && new Date(e.ts).getTime() >= start - MATCH_MS);
    const claimed = new Set<PoolMathArchiveEntry>();
    let updated = 0, added = 0, removed = 0;
    const newEntries: PoolMathArchiveEntry[] = [];

    for (const g of Array.from(groups.values()).sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
        let best: PoolMathArchiveEntry | undefined;
        let bestGap = Infinity;
        for (const c of candidates) {
            if (claimed.has(c)) continue;
            const gap = Math.abs(new Date(c.ts).getTime() - g.ts.getTime());
            if (gap <= MATCH_MS && gap < bestGap) { best = c; bestGap = gap; }
        }
        if (best) {
            claimed.add(best);
            let changed = false;
            for (const k of ['fc', 'cc', 'cya'] as const) {
                const v = g[k];
                if (best[k] !== v) { changed = true; if (typeof v === 'number') best[k] = v; else delete best[k]; }
            }
            if (changed) updated++;
        }
        else {
            const e: PoolMathArchiveEntry = { id: `page:${g.ts.toISOString()}`, type: 'testlog', ts: g.ts.toISOString() };
            for (const k of ['fc', 'cc', 'cya'] as const) { const v = g[k]; if (typeof v === 'number') e[k] = v; }
            newEntries.push(e);
            added++;
        }
    }
    // The same for SWG runs: update edited ones, add missing ones, drop ones the page no longer lists.
    const swgCandidates = archive.entries.filter(e => isSwgEntry(e) && new Date(e.ts).getTime() >= start - MATCH_MS);
    const swgClaimed = new Set<PoolMathArchiveEntry>();
    for (const g of [...(page.swg || [])].sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
        let best: PoolMathArchiveEntry | undefined;
        let bestGap = Infinity;
        for (const c of swgCandidates) {
            if (swgClaimed.has(c)) continue;
            const gap = Math.abs(new Date(c.ts).getTime() - g.ts.getTime());
            if (gap <= MATCH_MS && gap < bestGap) { best = c; bestGap = gap; }
        }
        if (best) {
            swgClaimed.add(best);
            if (best.amount !== g.ppmPerDay || best.runTime !== g.hrs || best.percent !== g.pct) {
                // normalizedAmount equals amount for the unit PoolMath uses for SWG entries; keep it in step
                if (best.normalizedAmount === best.amount) best.normalizedAmount = g.ppmPerDay;
                best.amount = g.ppmPerDay; best.runTime = g.hrs; best.percent = g.pct;
                updated++;
            }
        }
        else {
            newEntries.push({ id: `page:swg:${g.ts.toISOString()}`, type: 'chemlog', ts: g.ts.toISOString(), chemical: POOLMATH_SWG_CHEMICAL, runTime: g.hrs, percent: g.pct, amount: g.ppmPerDay, normalizedAmount: g.ppmPerDay });
            added++;
        }
    }

    // And liquid chlorine additions.
    const clCandidates = archive.entries.filter(e => isChlorineEntry(e) && new Date(e.ts).getTime() >= start - MATCH_MS);
    const clClaimed = new Set<PoolMathArchiveEntry>();
    for (const g of [...(page.chlorine || [])].sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
        let best: PoolMathArchiveEntry | undefined;
        let bestGap = Infinity;
        for (const c of clCandidates) {
            if (clClaimed.has(c)) continue;
            const gap = Math.abs(new Date(c.ts).getTime() - g.ts.getTime());
            if (gap <= MATCH_MS && gap < bestGap) { best = c; bestGap = gap; }
        }
        if (best) {
            clClaimed.add(best);
            // the page's amount is rounded for display, so compare loosely
            if (best.percent !== g.percent || Math.abs(best.normalizedAmount - g.ml) > Math.max(1, g.ml * 0.01)) {
                best.percent = g.percent; best.normalizedAmount = g.ml;
                updated++;
            }
        }
        else {
            newEntries.push({ id: `page:cl:${g.ts.toISOString()}`, type: 'chemlog', ts: g.ts.toISOString(), chemical: POOLMATH_LIQUID_CHLORINE, percent: g.percent, normalizedAmount: g.ml });
            added++;
        }
    }

    // Archived readings in the page's span that the page no longer lists were deleted (or had
    // their FC/CC/CYA cleared) in PoolMath: drop the entry unless it has other test values.
    const drop = new Set<PoolMathArchiveEntry>();
    for (const c of clCandidates) {
        if (clClaimed.has(c) || new Date(c.ts).getTime() < start) continue;
        drop.add(c);
        removed++;
    }
    for (const c of swgCandidates) {
        if (swgClaimed.has(c) || new Date(c.ts).getTime() < start) continue;
        drop.add(c);
        removed++;
    }
    for (const c of candidates) {
        if (claimed.has(c) || new Date(c.ts).getTime() < start) continue;
        delete c.fc; delete c.cc; delete c.cya;
        const keepsOther = ['ph', 'ta', 'ch', 'salt', 'waterTemp'].some(k => typeof (c as any)[k] === 'number');
        if (!keepsOther) drop.add(c);
        removed++;
    }
    if (!updated && !added && !removed) return { updated, added, removed };
    const entries = [...archive.entries.filter(e => !drop.has(e)), ...newEntries].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    writePoolMathArchive({ ...archive, entries });
    return { updated, added, removed };
}
