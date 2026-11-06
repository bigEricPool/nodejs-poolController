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

// One SWG Assist Tune at a time. A Tune runs a few thousand calculations and takes minutes on a Raspberry Pi, so a second request while one is
// going (a page refresh, a browser retry, a second click, or auto tune) joins the run in progress instead of starting another next to it. The run
// keeps going if the browser that started it goes away, and whoever started it records it once. While it runs, its progress is kept here for the
// /state/autoSwg/tune/status route.

export type TuneRunBy = 'manual' | 'auto';
export type TuneProgress = (phase: string, done: number, total: number) => void;

export interface TuneRunStatus {
    running: boolean;
    startedAt?: string;      // ISO
    by?: TuneRunBy;          // who started it: the Tune button or auto tune
    phase?: string;          // 'accuracy' (the current settings) or 'sweep' (the alternatives)
    done?: number;           // calculations done in this phase
    total?: number;          // calculations in this phase
}

interface TuneRunRecord<T> { promise: Promise<T>; startedAt: string; by: TuneRunBy; phase?: string; done?: number; total?: number; }

export class SingleFlightTune<T> {
    private run: TuneRunRecord<T> | undefined;
    constructor(private now: () => Date = () => new Date()) { }

    public get running(): boolean { return typeof this.run !== 'undefined'; }

    // The run in progress if there is one, otherwise a new one started with `work` (which gets a progress callback). `started` says which.
    // The run is released when it settles, whether it succeeded or failed.
    public join(by: TuneRunBy, work: (progress: TuneProgress) => Promise<T>): { promise: Promise<T>; started: boolean } {
        if (this.run) return { promise: this.run.promise, started: false };
        const rec: TuneRunRecord<T> = { promise: undefined as any, startedAt: this.now().toISOString(), by: by };
        const progress: TuneProgress = (phase, done, total) => { rec.phase = phase; rec.done = done; rec.total = total; };
        this.run = rec;
        let promise: Promise<T>;
        try { promise = Promise.resolve(work(progress)); }
        catch (err) { promise = Promise.reject(err); }   // a work function that throws before its first await
        rec.promise = promise;
        const release = () => { if (this.run === rec) this.run = undefined; };
        promise.then(release, release);
        return { promise: promise, started: true };
    }

    public status(): TuneRunStatus {
        const r = this.run;
        if (!r) return { running: false };
        return { running: true, startedAt: r.startedAt, by: r.by, phase: r.phase, done: r.done, total: r.total };
    }
}
