// SWG Assist Tune runs one at a time (controller/AutoSwgTuneRun.ts): a second request joins the run in progress, the run is released when it
// settles (also on an error), and its progress is reported while it runs.
import { describe, expect, it } from 'vitest';
import { SingleFlightTune } from '../../controller/AutoSwgTuneRun';

function deferred<T>() {
    let resolve: (v: T) => void, reject: (e: any) => void;
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve: resolve!, reject: reject! };
}
const tick = () => new Promise<void>(r => setImmediate(r));
const T0 = new Date(Date.UTC(2026, 10, 6, 12, 29, 33));

describe('single-flight Tune', () => {
    it('a second request joins the run in progress and gets the same result', async () => {
        const run = new SingleFlightTune<{ n: number }>(() => T0);
        const d = deferred<{ n: number }>();
        let starts = 0;
        const work = () => { starts++; return d.promise; };
        const a = run.join('manual', work);
        const b = run.join('manual', work);
        expect(a.started).toBe(true);
        expect(b.started).toBe(false);
        expect(b.promise).toBe(a.promise);
        expect(starts).toBe(1);
        const result = { n: 1 };
        d.resolve(result);
        expect(await a.promise).toBe(result);
        expect(await b.promise).toBe(result);
    });

    it('a manual request during an auto run joins it, and the status says who started it', async () => {
        const run = new SingleFlightTune<number>(() => T0);
        const d = deferred<number>();
        run.join('auto', () => d.promise);
        const m = run.join('manual', () => Promise.resolve(99));
        expect(m.started).toBe(false);
        expect(run.status()).toEqual({ running: true, startedAt: T0.toISOString(), by: 'auto', phase: undefined, done: undefined, total: undefined });
        d.resolve(7);
        expect(await m.promise).toBe(7);
    });

    it('is released when the run finishes, so the next request starts a new one', async () => {
        const run = new SingleFlightTune<number>(() => T0);
        await run.join('manual', async () => 1).promise;
        await tick();
        expect(run.running).toBe(false);
        expect(run.status()).toEqual({ running: false });
        const next = run.join('manual', async () => 2);
        expect(next.started).toBe(true);
        expect(await next.promise).toBe(2);
    });

    it('is released when the run fails, and every joiner sees the error', async () => {
        const run = new SingleFlightTune<number>(() => T0);
        const d = deferred<number>();
        const a = run.join('manual', () => d.promise);
        const b = run.join('manual', () => d.promise);
        d.reject(new Error('PoolMath returned HTTP 503'));
        await expect(a.promise).rejects.toThrow('HTTP 503');
        await expect(b.promise).rejects.toThrow('HTTP 503');
        await tick();
        expect(run.running).toBe(false);
    });

    it('is released when the work function throws before its first await', async () => {
        const run = new SingleFlightTune<number>(() => T0);
        const a = run.join('manual', () => { throw new Error('not configured'); });
        await expect(a.promise).rejects.toThrow('not configured');
        await tick();
        expect(run.running).toBe(false);
    });

    it('reports the progress of the run in progress', async () => {
        const run = new SingleFlightTune<number>(() => T0);
        const d = deferred<number>();
        let report: (phase: string, done: number, total: number) => void;
        run.join('manual', p => { report = p; return d.promise; });
        report!('accuracy', 40, 100);
        expect(run.status()).toMatchObject({ running: true, phase: 'accuracy', done: 40, total: 100 });
        report!('sweep', 500, 1300);
        expect(run.status()).toMatchObject({ phase: 'sweep', done: 500, total: 1300 });
        d.resolve(1);
        await d.promise;
        await tick();
        expect(run.status()).toEqual({ running: false });
    });

    it('a late progress report from a finished run does not touch the next one', async () => {
        const run = new SingleFlightTune<number>(() => T0);
        let first: (phase: string, done: number, total: number) => void;
        await run.join('manual', async p => { first = p; return 1; }).promise;
        await tick();
        const d = deferred<number>();
        run.join('auto', () => d.promise);
        first!('sweep', 9, 9);
        expect(run.status()).toMatchObject({ running: true, by: 'auto', phase: undefined });
        d.resolve(2);
    });
});
