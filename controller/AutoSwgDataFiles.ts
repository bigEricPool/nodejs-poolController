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

// Moves one of SWG Assist's data files to its new name for the pool's logging feature (see AutoSwgMigration.ts).
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';

// Copies `from` to `to` unless `to` exists, checks the copy, then renames `from` to `from.bak`. Returns what was done.
export function moveDataFile(from: string, to: string): 'moved' | 'kept' | 'none' | 'failed' {
    const tmp = `${to}.tmp`;
    try {
        if (!fs.existsSync(from)) return 'none';
        if (fs.existsSync(to)) { logger.warn(`SWG Assist: both ${from} and ${to} exist; ${to} is used and ${from} is left alone.`); return 'kept'; }
        fs.copyFileSync(from, tmp);
        const a = fs.statSync(from).size, b = fs.statSync(tmp).size;
        if (a !== b) { fs.unlinkSync(tmp); logger.error(`SWG Assist: copying ${from} gave ${b} bytes instead of ${a}; it was not moved.`); return 'failed'; }
        if (to.endsWith('.json')) JSON.parse(fs.readFileSync(tmp, 'utf8'));
        fs.renameSync(tmp, to);
        fs.renameSync(from, `${from}.bak`);
        logger.info(`SWG Assist: ${path.basename(from)} is now ${path.basename(to)} (the old file is kept as ${path.basename(from)}.bak).`);
        return 'moved';
    }
    catch (err) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* nothing more can be done */ }
        logger.error(`SWG Assist: could not move ${from}: ${err.message}`);
        return 'failed';
    }
}
