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

// The chlorinator output log, the cell usage and the PoolMath archive used to be SWG Assist's (autoSwg* settings and data files); they are now the
// pool's own logging feature (ChlorinatorLog.ts, ChlorinatorUsage.ts, PoolMathArchive.ts). This moves what an existing install already has, once and
// before the logging starts (it is called when the web service starts; the logging starts after):
//   - the data files: copied under their new names, checked, and the old ones kept as .bak (rolling back: rename the .bak files to their old names)
//   - the share code and pool name, to the pool-level poolMath section (and the pool volume SWG Assist was set to, until PoolMath's own is read)
//   - the cell's install date and rating, to the chlorinator SWG Assist controls (the old rating default of 1.45 lb/day becomes the AquaRite T15's 1.47;
//     a rating that was changed by hand is carried over as it is)
// The old keys stay in poolConfig.json for one release, so rolling back loses nothing. The cell totals are counted again once, a minute after start,
// when the PoolMath history is available to them.
import * as path from 'path';
import { logger } from '../logger/Logger';
import { sys } from './Equipment';
import { chlorinatorLog } from './ChlorinatorLog';
import { recountCellUsage } from './ChlorinatorLogService';
import { moveDataFile } from './AutoSwgDataFiles';

const OLD_DEFAULT_LBS_PER_DAY = 1.45;
const T15_LBS_PER_DAY = 1.47;
const RECOUNT_DELAY_MS = 60 * 1000;

export function migrateToChlorinatorLog() {
    try {
        const dir = path.join(process.cwd(), 'data');
        moveDataFile(path.join(dir, 'autoSwgOutputLog.jsonl'), chlorinatorLog.file());
        moveDataFile(path.join(dir, 'autoSwgPoolMathArchive.json'), path.join(dir, 'poolMathArchive.json'));
        const cfg = sys.autoSwg;
        if (cfg.chlorinatorLogMigrated) return;
        const old = (cfg as any).data || {};
        if (!sys.poolMath.shareCode && typeof old.shareCode === 'string' && old.shareCode) sys.poolMath.shareCode = old.shareCode;
        if (!sys.poolMath.poolName && typeof old.poolName === 'string' && old.poolName) sys.poolMath.poolName = old.poolName;
        // The pool volume the estimate before the log needs comes from PoolMath's next read; until then it is the one SWG Assist was set to.
        if (!(sys.poolMath.gallons > 0) && typeof old.gallons === 'number' && old.gallons > 0) sys.poolMath.gallons = old.gallons;
        const chlors = sys.chlorinators.toArray();
        const chlor = chlors.find(c => c.id === cfg.chlorinatorId) || chlors[0];
        let recount = false;
        if (chlor) {
            if (!chlor.cellInstalledDate && typeof old.cellInstalledDate === 'string' && old.cellInstalledDate) { chlor.cellInstalledDate = old.cellInstalledDate; recount = true; }
            if (typeof chlor.cellLbsPerDaySetting === 'undefined') {
                const lbs = typeof old.swgLbsPerDay === 'number' && old.swgLbsPerDay > 0 ? old.swgLbsPerDay : OLD_DEFAULT_LBS_PER_DAY;
                chlor.cellLbsPerDay = lbs === OLD_DEFAULT_LBS_PER_DAY ? T15_LBS_PER_DAY : lbs;
            }
        }
        if (!recount || !chlor) { cfg.chlorinatorLogMigrated = new Date().toISOString(); return; }
        // The marker is set after the recount, so a restart before it runs the recount again.
        const id = chlor.id;
        const t = setTimeout(() => {
            try { recountCellUsage(id); cfg.chlorinatorLogMigrated = new Date().toISOString(); logger.info(`SWG Assist: the cell usage of chlorinator ${id} was counted again from its install date.`); }
            catch (err) { logger.warn(`SWG Assist: could not count the cell usage again: ${err.message}`); }
        }, RECOUNT_DELAY_MS);
        t.unref();
    }
    catch (err) { logger.error(`SWG Assist: moving the logging settings and files failed: ${err.message}`); }
}
