// A relay pump's latch check (controller/nixie/pumps/Pump.ts checkLatchAsync) tells the chlorinator power log about a gap in its relay
// refreshes (ChlorinatorLogService.noteChlorinatorRelayGap), so a chlorinator powered through those relays gets its short drop logged. The
// equipment, state, comms and chlorinator log modules are small fakes; the clock is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ gaps: [] as any[][], warns: [] as string[], throwOnGap: false }));

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: (m: string) => { fx.warns.push(m); }, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));
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
vi.mock('../../controller/ChlorinatorLogService', () => ({
    noteChlorinatorRelayGap: (...a: any[]) => { if (fx.throwOnGap) throw new Error('boom'); fx.gaps.push(a); return []; },
}));

import { NixiePump } from '../../controller/nixie/pumps/Pump';

const REM = 'rem-1';
const LOW = { connectionId: REM, deviceBinding: 'i2c:1:1:1' }, HIGH = { connectionId: REM, deviceBinding: 'i2c:1:1:3' };
// A pump whose running state the test sets; priming starts are only counted.
class TestPump extends NixiePump {
    public primed = 0;
    public run(targetSpeed: number, priming = false) {
        this._targetSpeed = targetSpeed;
        this._priming = priming ? { until: Date.now() + 60000, trigger: undefined, circuitOn: false } : undefined;
    }
    public async startPrimingAsync() { this.primed++; }
    public check(relaysSet = true) { return this.checkLatchAsync(relaysSet); }
}
const T = Date.parse('2026-11-13T22:07:00.000Z');
let pump: TestPump;
const at = (ms: number) => vi.setSystemTime(new Date(ms));

beforeEach(async () => {
    vi.useFakeTimers();
    fx.gaps = []; fx.warns = []; fx.throwOnGap = false;
    pump = new TestPump({} as any, { id: 50, name: 'Calimar', type: 2, primingEnabled: true, circuits: [], relays: { get: () => [{ id: 1, ...LOW }, { id: 2, ...HIGH }] } } as any);
    pump.run(1);
    at(T); await pump.check();       // the first pass after start: primes, nothing to note
    pump.primed = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('NixiePump.checkLatchAsync and the chlorinator power log', () => {
    it('notes a 5.1 s gap with the pump\'s own relays', async () => {
        at(T + 2000); await pump.check();
        at(T + 7100); await pump.check();
        expect(fx.gaps).toEqual([[T + 2000, T + 7100, [LOW, HIGH]]]);
    });
    it('notes nothing for the first pass, for gaps within the latch, or while the pump is off', async () => {
        expect(fx.gaps).toEqual([]);
        at(T + 5000); await pump.check();          // exactly the latch
        expect(fx.gaps).toEqual([]);
        pump.run(0);
        at(T + 20000); await pump.check();
        pump.run(1);
        at(T + 30000); await pump.check();         // starting again is not a gap
        expect(fx.gaps).toEqual([]);
    });
    it('still notes the gap while the pump is priming, and only once', async () => {
        pump.run(1, true);
        at(T + 8000); await pump.check();
        at(T + 9000); await pump.check();
        expect(fx.gaps).toEqual([[T, T + 8000, [LOW, HIGH]]]);
        expect(pump.primed).toBe(0);
    });
    it('keeps priming when the power log fails', async () => {
        fx.throwOnGap = true;
        at(T + 12600); await pump.check();
        expect(pump.primed).toBe(1);
        expect(fx.warns[0]).toContain('Could not note the relay gap of pump Calimar');
    });
});
