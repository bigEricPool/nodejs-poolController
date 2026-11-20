// The SWG Assist salt history (controller/AutoSwgSaltHistory.ts), kept in a temporary data folder.
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salthist-'));
vi.spyOn(process, 'cwd').mockReturnValue(dir);

import { saltHistory } from '../../controller/AutoSwgSaltHistory';

const H = 3600000;
const T = new Date('2026-11-18T12:00:00.000Z').getTime();

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('saltHistory.record', () => {
    it('keeps only readings taken while the chlorinator was answering', () => {
        // 12 hours answering at 3300, then 12 hours silent with njsPC holding 3300, then 12 hours answering at 3000.
        for (let i = 0; i < 12; i++) saltHistory.record(3300, T + i * H, 3);
        for (let i = 12; i < 24; i++) saltHistory.record(3300, T + i * H, (i - 11) * 3600);
        for (let i = 24; i < 36; i++) saltHistory.record(3000, T + i * H, 2);
        expect(saltHistory.count()).toBe(24);
        // The last 24 hours: the 12 held hours are not counted, so the median is the 3000 the cell measured, not a mix with the held 3300.
        const [day] = saltHistory.daily(1, T + 35 * H);
        expect(day.median).toBe(3000);
        expect(day.count).toBe(12);
    });
    it('keeps a reading when the time since the last answer is not known', () => {
        const n = saltHistory.count();
        saltHistory.record(3000, T + 40 * H);
        expect(saltHistory.count()).toBe(n + 1);
    });
});
