// Priming when a schedule starts a relay pump (controller/nixie/pumps/Pump.ts primeForScheduleAsync / scheduleStartSkipsPriming): a pump that is
// already running, already priming, or was off only briefly is not primed again. The equipment, state and comms modules are small fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ info: [] as string[] }));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: (m: string) => { fx.info.push(m); }, verbose: () => {}, debug: () => {}, silly: () => {} } }));
vi.mock('../../controller/Equipment', () => ({ sys: { board: { valueMaps: { pumpTypes: { transform: () => ({ name: 'ds', schedulePriming: true }) } } } } }));
vi.mock('../../controller/State', () => ({ state: {} }));
vi.mock('../../controller/nixie/NixieEquipment', () => {
    class NixieEquipment { public _pmap: any = {}; constructor(ncp: any) { this._pmap['ncp'] = ncp; } public get controlPanel() { return this._pmap['ncp']; } }
    class NixieChildEquipment extends NixieEquipment { }
    class NixieEquipmentCollection extends Array { public _pmap: any = {}; constructor(ncp: any) { super(); this._pmap['ncp'] = ncp; } }
    return { NixieEquipment, NixieChildEquipment, NixieEquipmentCollection };
});
vi.mock('../../controller/nixie/Nixie', () => ({ NixieControlPanel: class { } }));
vi.mock('../../web/Server', () => ({ webApp: {}, InterfaceServerResponse: class { } }));
vi.mock('../../controller/comms/messages/Messages', () => ({ Message: class { }, Inbound: class { }, Outbound: class { }, Protocol: {}, Response: class { } }));
vi.mock('../../controller/comms/Comms', () => ({ conn: {} }));
vi.mock('../../controller/comms/messages/status/NeptuneModbusStateMessage', () => ({ NeptuneModbusStateMessage: class { } }));

import { NixiePump, NixiePumpCollection } from '../../controller/nixie/pumps/Pump';

// A pump whose running state the test sets, and whose priming start is only recorded.
class TestPump extends NixiePump {
    public started: number[] = [];
    public set(targetSpeed: number, stoppedAt?: number, priming = false) {
        this._targetSpeed = targetSpeed;
        this._stoppedAt = stoppedAt;
        this._priming = priming ? { until: Date.now() + 60000, trigger: 6, circuitOn: false } : undefined;
    }
    public reasons: string[] = [];
    public async startPrimingAsync(triggerCircuitId?: number, reason?: string) { this.started.push(triggerCircuitId); this.reasons.push(reason); }
    public latchAsync(relaysSet = true) { return this.checkLatchAsync(relaysSet); }
}
const T = Date.parse('2026-11-09T11:43:00.000Z');
let pump: TestPump, pumps: NixiePumpCollection;

beforeEach(() => {
    fx.info = [];
    pump = new TestPump({} as any, { id: 50, name: 'Calimar', type: 2, primingEnabled: true, circuits: [{ circuit: 6 }, { circuit: 2 }] } as any);
    pumps = new NixiePumpCollection({} as any);
    pumps.push(pump);
});

describe('NixiePump.scheduleStartSkipsPriming', () => {
    it('primes a pump that is off, found off at startup or off for over 30 s', () => {
        pump.set(0, undefined);
        expect(pump.scheduleStartSkipsPriming(T)).toBeUndefined();
        pump.set(0, 0);
        expect(pump.scheduleStartSkipsPriming(T)).toBeUndefined();
        pump.set(0, T - 31000);
        expect(pump.scheduleStartSkipsPriming(T)).toBeUndefined();
    });
    it('does not prime a pump that is running, priming, or was off for 30 s or less', () => {
        pump.set(1, undefined);
        expect(pump.scheduleStartSkipsPriming(T)).toBe('it is already running');
        pump.set(3, undefined, true);
        expect(pump.scheduleStartSkipsPriming(T)).toBe('it is priming already');
        pump.set(0, T - 30000);
        expect(pump.scheduleStartSkipsPriming(T)).toBe('it was off for only 30 s');
    });
});

describe('NixiePumpCollection.primeForScheduleAsync', () => {
    it('primes for the first schedule and not for a second one while the pump runs', async () => {
        pump.set(0, 0);
        await pumps.primeForScheduleAsync(6);
        expect(pump.started).toEqual([6]);
        pump.set(1, undefined);   // the pump is now running on the Pool circuit's speed
        await pumps.primeForScheduleAsync(2);
        expect(pump.started).toEqual([6]);
        expect(fx.info).toEqual(['NCP: Not priming pump Calimar for the schedule that turned circuit 2 on: it is already running.']);
    });
    it('ignores a circuit the pump does not run for, and logs nothing when priming is off', async () => {
        pump.set(1, undefined);
        await pumps.primeForScheduleAsync(9);
        (pump.pump as any).primingEnabled = false;
        await pumps.primeForScheduleAsync(2);
        expect(pump.started).toEqual([]);
        expect(fx.info).toEqual([]);
    });
});

// The relay gap is measured between finished passes, so it holds each pass's own send time: only a gap past the 5 s latch by over 1 s primes.
describe('NixiePump relay gap priming', () => {
    async function gapPrimes(gapMs: number): Promise<boolean> {
        vi.useFakeTimers();
        try {
            pump.set(1, undefined);
            vi.setSystemTime(T);
            await pump.latchAsync();            // the first pass after startup primes (njsPC started with the pump on)
            pump.started = []; pump.reasons = [];
            vi.setSystemTime(T + 3000);
            await pump.latchAsync();            // a normal refresh
            vi.setSystemTime(T + 3000 + gapMs);
            await pump.latchAsync();
            return pump.started.length > 0;
        } finally { vi.useRealTimers(); }
    }
    it('does not prime for gaps of 5.1 s and 5.6 s (the latch did not run out on the live system)', async () => {
        expect(await gapPrimes(5100)).toBe(false);
        expect(await gapPrimes(5600)).toBe(false);
        expect(await gapPrimes(6000)).toBe(false);
    });
    it('primes for gaps of 6.3 s and 7.8 s (the relay manager logged the latch running out)', async () => {
        expect(await gapPrimes(6300)).toBe(true);
        expect(pump.reasons).toEqual(['its relays were not refreshed for 6.3 s, longer than their 5 s latch']);
        expect(await gapPrimes(7800)).toBe(true);
    });
    it('relayGapExpired: the threshold is the latch plus 1 s', () => {
        expect(NixiePump.relayGapExpired(6000)).toBe(false);
        expect(NixiePump.relayGapExpired(6001)).toBe(true);
    });
});
