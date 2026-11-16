// The PoolMath SWG log's run hours from a schedule (controller/PoolMathSwgLogService.ts): the chosen schedule's window for the day, rounded
// to whole hours, else the hours set by hand. sys and state are small fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
    poolMath: { swgLogEnabled: true, swgLogHours: 9, swgLogScheduleId: -1 } as any,
    schedules: [] as any[],
    window: { startTime: null as Date | null, endTime: null as Date | null },
}));
vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/ChlorinatorLogService', () => ({ poolGallons: () => 12000 }));
vi.mock('../../controller/ChlorinatorSuperChlorLog', () => ({ onSuperChlorRunEnded: () => {} }));
vi.mock('../../controller/Equipment', () => ({ sys: { poolMath: fx.poolMath, schedules: { toArray: () => fx.schedules }, chlorinators: { toArray: () => [] } } }));
vi.mock('../../controller/State', () => ({ state: {
    time: {},
    schedules: { getItemById: () => ({ scheduleTime: { calcScheduleDate: () => fx.window } }) },
    chlorinators: { getItemById: () => ({}) },
} }));

import { setPoolMathSwgLogSettings, swgLogSettings, windowHours } from '../../controller/PoolMathSwgLogService';

const at = (h: number, m = 0) => new Date(2026, 10, 15, h, m);
beforeEach(() => {
    fx.poolMath.swgLogEnabled = true; fx.poolMath.swgLogHours = 9; fx.poolMath.swgLogScheduleId = -1;
    fx.schedules = [{ id: 3, circuit: 6, disabled: false, startTime: 420, endTime: 1080 }];
    fx.window = { startTime: at(6, 52), endTime: at(17, 31) };
});

describe('windowHours', () => {
    it('rounds the window to whole hours', () => {
        expect(windowHours(at(6, 52), at(17, 31))).toBe(11);
        expect(windowHours(at(7), at(16))).toBe(9);
    });
    it('handles a window past midnight and no window', () => {
        expect(windowHours(at(22), at(2))).toBe(4);
        expect(windowHours(null, at(2))).toBe(0);
    });
});

describe('swgLogSettings', () => {
    it('uses the hours set by hand without a schedule', () => {
        expect(swgLogSettings()).toMatchObject({ hours: 9, hoursSource: 'set' });
    });
    it('uses the chosen schedule\'s window for the day', () => {
        fx.poolMath.swgLogScheduleId = 3;
        expect(swgLogSettings()).toMatchObject({ enabled: true, hours: 11, hoursSource: 'schedule' });
    });
    it('falls back to the schedule\'s saved times when today\'s window is not known', () => {
        fx.poolMath.swgLogScheduleId = 3;
        fx.window = { startTime: null, endTime: null };
        expect(swgLogSettings()).toMatchObject({ hours: 11, hoursSource: 'schedule' });
    });
    it('falls back to the hours set by hand when the schedule is gone or disabled, and says so', () => {
        fx.poolMath.swgLogScheduleId = 3;
        fx.schedules[0].disabled = true;
        expect(swgLogSettings()).toMatchObject({ hours: 9, hoursSource: 'set', hoursNote: expect.stringMatching(/missing or disabled.*9 h/) });
        fx.schedules = [];
        fx.poolMath.swgLogHours = 0;
        expect(swgLogSettings()).toMatchObject({ hours: 0, hoursNote: expect.stringMatching(/nothing is written/) });
    });
});

describe('setPoolMathSwgLogSettings', () => {
    it('accepts a schedule that exists, or -1 / null for none', () => {
        setPoolMathSwgLogSettings({ swgLogScheduleId: 3 });
        expect(fx.poolMath.swgLogScheduleId).toBe(3);
        setPoolMathSwgLogSettings({ swgLogScheduleId: null });
        expect(fx.poolMath.swgLogScheduleId).toBe(-1);
    });
    it('refuses a schedule that does not exist', () => {
        expect(() => setPoolMathSwgLogSettings({ swgLogScheduleId: 8 })).toThrow(/no schedule #8/);
    });
});
