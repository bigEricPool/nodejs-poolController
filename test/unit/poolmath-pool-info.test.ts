// PoolMath pool details (controller/PoolMathSync.ts applyPoolInfo, controller/PoolMathArchive.ts poolInfoOf): a change in PoolMath's
// rating or volume recounts the cells that use them. sys and the recount are small fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
    poolMath: { gallons: 0, swgLbsPerDay: 0 },
    chlors: [] as { id: number; setting?: number; model: number; cellInstalledDate: string }[],
    recount: [] as number[],
}));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/ChlorinatorLogService', () => ({
    setPoolLogSwgEntriesSource: () => {},
    recountCellUsage: (id: number) => { fx.recount.push(id); },
}));
vi.mock('../../controller/Equipment', () => ({ sys: {
    poolMath: fx.poolMath,
    chlorinators: {
        get length() { return fx.chlors.length; },
        // the rating in effect, as Chlorinator.cellLbsPerDay works it out
        toArray: () => fx.chlors.map(c => ({
            id: c.id, cellInstalledDate: c.cellInstalledDate,
            get cellLbsPerDay() { return c.setting > 0 ? c.setting : (fx.chlors.length === 1 && fx.poolMath.swgLbsPerDay > 0 ? fx.poolMath.swgLbsPerDay : c.model); },
        })),
    },
} }));

import { applyPoolInfo } from '../../controller/PoolMathSync';
import { poolInfoOf } from '../../controller/PoolMathArchive';

beforeEach(() => {
    fx.poolMath.gallons = 12000; fx.poolMath.swgLbsPerDay = 1.47;
    fx.chlors = [{ id: 50, model: 1.47, cellInstalledDate: '2026-07-12' }];
    fx.recount = [];
});

describe('applyPoolInfo', () => {
    it('recounts a cell that counts at PoolMath\'s rating when that changes', () => {
        expect(applyPoolInfo({ gallons: 12000, swgLbsPerDay: 1.6 })).toEqual([50]);
        expect(fx.poolMath.swgLbsPerDay).toBe(1.6);
    });
    it('does not recount when nothing changed', () => {
        expect(applyPoolInfo({ gallons: 12000, swgLbsPerDay: 1.47 })).toEqual([]);
    });
    it('does not recount a cell with its own rating when only the rating changed', () => {
        fx.chlors[0].setting = 1.47;
        expect(applyPoolInfo({ gallons: 12000, swgLbsPerDay: 1.6 })).toEqual([]);
    });
    it('recounts when the volume changes (it is used for the estimate before the log)', () => {
        fx.chlors[0].setting = 1.47;
        expect(applyPoolInfo({ gallons: 13000, swgLbsPerDay: 1.47 })).toEqual([50]);
        expect(fx.poolMath.gallons).toBe(13000);
    });
    it('does not recount a cell without an install date', () => {
        fx.chlors[0].cellInstalledDate = '';
        expect(applyPoolInfo({ gallons: 12000, swgLbsPerDay: 1.6 })).toEqual([]);
    });
    it('ignores missing values', () => {
        expect(applyPoolInfo({})).toEqual([]);
        expect(applyPoolInfo(undefined)).toEqual([]);
        expect(fx.poolMath.gallons).toBe(12000);
    });
});

describe('poolInfoOf', () => {
    it('reads the volume in gallons and the SWG rating', () => {
        expect(poolInfoOf({ pool: { name: 'Pool', volume: 12000, poolVolumeUnit: 0, swgLbsPerDay: 1.47, swgModelId: 'hayward-aquarite-t15' } }))
            .toEqual({ name: 'Pool', gallons: 12000, swgLbsPerDay: 1.47, swgModelId: 'hayward-aquarite-t15' });
        expect(poolInfoOf({ pool: { volume: 17500 } }).gallons).toBe(17500);
    });
    it('leaves out a volume in another unit', () => {
        expect(poolInfoOf({ pool: { volume: 45000, poolVolumeUnit: 1 } }).gallons).toBeUndefined();
    });
});
