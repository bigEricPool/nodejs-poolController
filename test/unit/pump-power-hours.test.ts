// The pump power log read by the hour for other modules (controller/PumpPower.ts pumpHourRows): one row per pump and hour, oldest first, with the
// seconds at each speed, on in all, and off.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/Equipment', () => ({ sys: { pumps: { getItemById: () => ({}) }, circuits: { get: () => [] } } }));
vi.mock('../../controller/State', () => ({ state: { pumps: { getItemById: () => ({}) }, circuits: { getItemById: () => ({}) } } }));

import { pumpHourRows } from '../../controller/PumpPower';

const H = 3600000;
describe('pump power by the hour', () => {
    const hours = new Map<number, { [pump: string]: { [key: string]: number } }>([
        [3 * H, { '50': { '1': 1800, '2': 600, off: 1200 } }],
        [1 * H, { '50': { '0': 3600, off: 0 }, '51': { off: 3600 } }],
        [2 * H, { '50': { off: 3600 } }],
    ]);
    it('returns the hours in the range, oldest first, one row per pump', () => {
        const rows = pumpHourRows(hours, 1 * H, 3 * H);
        expect(rows.map(r => [r.t / H, r.pump])).toEqual([[1, 50], [1, 51], [2, 50]]);
        expect(rows[0]).toEqual({ t: H, pump: 50, speeds: { '0': 3600 }, on: 3600, off: 0 });
        expect(rows[1].on).toBe(0);
    });
    it('adds the speeds up to the time on, and can keep to one pump', () => {
        const rows = pumpHourRows(hours, 0, 10 * H, 50);
        expect(rows.length).toBe(3);
        expect(rows[2]).toEqual({ t: 3 * H, pump: 50, speeds: { '1': 1800, '2': 600 }, on: 2400, off: 1200 });
    });
});
