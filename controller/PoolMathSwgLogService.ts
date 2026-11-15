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

// Runs the PoolMath SWG log (PoolMathSwgLog.ts) for the configured chlorinator: one PoolMath client for the life of the process (one
// sign-in per start, plus one each time the token expires), checked every 15 seconds. The settings are swgLogEnabled and swgLogHours in
// the poolMath section of poolConfig.json (PUT /config/poolMath); the status is GET /state/poolMath/swgLog.

import * as path from 'path';
import { logger } from '../logger/Logger';
import { sys } from './Equipment';
import { state } from './State';
import { poolGallons } from './ChlorinatorLogService';
import { onSuperChlorRunEnded } from './ChlorinatorSuperChlorLog';
import { PoolMathClient } from './PoolMathClient';
import { SwgLogReading, SwgLogStatus, SwgLogWriter } from './PoolMathSwgLog';

const CHECK_MS = 15 * 1000;
let writer: SwgLogWriter | undefined;
let timer: NodeJS.Timeout | undefined;

function reading(): SwgLogReading {
    const chlors = sys.chlorinators.toArray();
    if (chlors.length !== 1) return { ok: false, reason: chlors.length ? 'PoolMath SWG entries are written only when there is one chlorinator.' : 'No chlorinator is configured.' };
    const c = chlors[0];
    const pct = c.poolSetpoint;
    if (typeof pct !== 'number' || !isFinite(pct)) return { ok: false, reason: 'The chlorinator has no pool % yet.' };
    const lbs = c.cellLbsPerDay;
    const gallons = poolGallons();
    if (!(lbs > 0) || !(gallons > 0)) return { ok: false, reason: 'The cell rating or the pool volume is not known, so the FC cannot be worked out.' };
    return { ok: true, percent: pct, superChlorOn: state.chlorinators.getItemById(c.id).superChlor === true, lbsPerDay: lbs, gallons };
}

export function startPoolMathSwgLog() {
    if (writer) return;
    writer = new SwgLogWriter({
        client: new PoolMathClient({ userAgent: `nodejs-poolController/${sys.appVersion || ''} (PoolMath SWG log)` }),
        settings: () => ({ enabled: sys.poolMath.swgLogEnabled, hours: sys.poolMath.swgLogHours }),
        reading,
        file: path.join(process.cwd(), 'data', 'poolMathSwgLog.json')
    });
    writer.start();
    onSuperChlorRunEnded(run => { if (writer) writer.superChlorEnded(run); });
    timer = setTimeout(function check() {
        const w = writer;
        if (!w) return;
        w.tick().finally(() => { if (writer) timer = setTimeout(check, CHECK_MS); });
    }, CHECK_MS);
    timer.unref();
}

export function stopPoolMathSwgLog() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    writer = undefined;
}

export function poolMathSwgLogStatus(): SwgLogStatus | { enabled: boolean } {
    return writer ? writer.status() : { enabled: sys.poolMath.swgLogEnabled };
}

// swgLogEnabled (true/false) and swgLogHours (whole hours from 1 to 24; 0 or null clears it) from PUT /config/poolMath.
export function setPoolMathSwgLogSettings(obj: any) {
    if (!obj) return;
    if (typeof obj.swgLogHours !== 'undefined') {
        const v = obj.swgLogHours === null || obj.swgLogHours === '' ? 0 : Number(obj.swgLogHours);
        if (!Number.isInteger(v) || v < 0 || v > 24) throw new RangeError('The SWG run hours a day must be a whole number of hours from 1 to 24 (0 clears it).');
        sys.poolMath.swgLogHours = v;
    }
    if (typeof obj.swgLogEnabled !== 'undefined') {
        if (typeof obj.swgLogEnabled !== 'boolean') throw new RangeError('swgLogEnabled must be true or false.');
        if (obj.swgLogEnabled !== sys.poolMath.swgLogEnabled) logger.info(`PoolMath SWG log: writing to PoolMath turned ${obj.swgLogEnabled ? 'on' : 'off'}.`);
        sys.poolMath.swgLogEnabled = obj.swgLogEnabled;
    }
}
