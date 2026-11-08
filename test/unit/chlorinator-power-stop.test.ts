// A chlorinator's power when njsPC stops (controller/ChlorinatorLogService.ts markPowerOffWhileStopped): on Nixie the circuits go off with
// njsPC, so the power log gets an "off"; a controller with its own panel keeps them running. sys and the power log are small fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
    controllerType: 'nixie',
    events: [] as { id: number; on: boolean; t: number }[],
}));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/Equipment', () => ({ sys: {
    get controllerType() { return fx.controllerType; },
    chlorinators: { toArray: () => [{ id: 50 }, { id: 51 }] },
} }));
vi.mock('../../controller/State', () => ({ state: {} }));
vi.mock('../../controller/Errors', () => ({ ServiceParameterError: class extends Error { } }));
vi.mock('../../controller/ChlorinatorPowerLog', () => ({ chlorinatorPowerLog: {
    lastEvent: (id: number) => { const e = fx.events.filter(x => x.id === id); return e.length ? { id, on: e[e.length - 1].on, t: new Date(e[e.length - 1].t).toISOString() } : undefined; },
    record: (id: number, on: boolean, now: number) => { fx.events.push({ id, on, t: now }); return { id, on }; },
} }));

import { markPowerOffWhileStopped } from '../../controller/ChlorinatorLogService';

const T = Date.parse('2026-11-08T20:00:00.000Z');
beforeEach(() => { fx.controllerType = 'nixie'; fx.events = []; });

describe('markPowerOffWhileStopped', () => {
    it('marks a powered chlorinator off on Nixie, and leaves one already off or never logged alone', () => {
        fx.events.push({ id: 50, on: true, t: T - 60000 });
        markPowerOffWhileStopped(T);
        expect(fx.events).toEqual([{ id: 50, on: true, t: T - 60000 }, { id: 50, on: false, t: T }]);
        markPowerOffWhileStopped(T + 1000);   // a start after a clean stop adds nothing
        expect(fx.events).toHaveLength(2);
    });
    it('does nothing on a controller with its own panel', () => {
        fx.controllerType = 'intellicenter';
        fx.events.push({ id: 50, on: true, t: T - 60000 });
        markPowerOffWhileStopped(T);
        expect(fx.events).toHaveLength(1);
    });
});
