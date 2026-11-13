// SWG Assist's automatic checks are pinned to the clock (every 12 hours from 10:00: 10:00 and 22:00). A restart or a settings save a minute before a check time used
// to skip it for a whole interval (the next check was scheduled at least 5 minutes ahead, and the only anchor in range was 12 hours later), which is what happened on
// 2026-11-12 when njsPC restarted at 21:58:53 and the 22:00 check never ran. These tests cover the scheduler (controller/AutoSwgService.ts).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { latestCheckMs, missedScheduledCheck, nextScheduledCheck } from '../../controller/AutoSwgService';

const TZ = 'America/New_York';
const FLOOR = 5 * 60 * 1000;
// 2026-11-12 is in standard time (UTC-5): 22:00 local = 03:00 UTC on the 13th.
const local = (h: number, m: number, s: number = 0, day: number = 12) => new Date(Date.UTC(2026, 10, day, h + 5, m, s));

describe('nextScheduledCheck', () => {
    it('uses the next check time when it is further away than the floor', () => {
        expect(nextScheduledCheck(local(20, 0), '10:00', 12, TZ, FLOOR).toISOString()).toBe(local(22, 0).toISOString());
        expect(nextScheduledCheck(local(10, 0, 3), '10:00', 12, TZ, FLOOR).toISOString()).toBe(local(22, 0).toISOString());   // re-armed right after the 10:00 check
    });

    it('runs a check time inside the floor at the floor instead of skipping it', () => {
        const now = local(21, 59, 1);                       // njsPC back up one minute before 22:00
        expect(nextScheduledCheck(now, '10:00', 12, TZ, FLOOR).getTime()).toBe(now.getTime() + FLOOR);
        const now2 = local(21, 55, 0);                      // 22:00 is exactly 5 minutes away
        expect(nextScheduledCheck(now2, '10:00', 12, TZ, FLOOR).toISOString()).toBe(local(22, 0).toISOString());
    });

    it('does not make up a check time that already passed (the check that just ran re-arms right after its own time)', () => {
        expect(nextScheduledCheck(local(22, 0, 2), '10:00', 12, TZ, FLOOR).toISOString()).toBe(local(10, 0, 0, 13).toISOString());
    });
});

describe('missedScheduledCheck', () => {
    const lastAt = (h: number, m: number, s: number = 0) => local(h, m, s).toISOString();

    it('is true when a check time passed with no check since', () => {
        expect(missedScheduledCheck(local(22, 6), lastAt(10, 0, 1), '10:00', 12, TZ)).toBe(true);     // restarted at 22:06, the 22:00 check was missed
        expect(missedScheduledCheck(local(23, 30), lastAt(10, 0, 1), '10:00', 12, TZ)).toBe(true);
    });

    it('is false when the last check is at or after the latest check time', () => {
        expect(missedScheduledCheck(local(22, 6), lastAt(22, 0, 2), '10:00', 12, TZ)).toBe(false);
        expect(missedScheduledCheck(local(22, 0, 3), lastAt(22, 0, 1), '10:00', 12, TZ)).toBe(false);   // the check that has just run, re-arming
        expect(missedScheduledCheck(local(15, 0), lastAt(10, 0, 1), '10:00', 12, TZ)).toBe(false);       // nothing due since 10:00
    });

    it('allows a minute of slack, and treats a check that never ran as not missed', () => {
        expect(missedScheduledCheck(local(22, 6), lastAt(21, 59, 30), '10:00', 12, TZ)).toBe(false);
        expect(missedScheduledCheck(local(22, 6), undefined, '10:00', 12, TZ)).toBe(false);
        expect(missedScheduledCheck(local(22, 6), 'not a date', '10:00', 12, TZ)).toBe(false);
    });

    it('accepts a time in milliseconds (a failed attempt in this process counts as a check)', () => {
        expect(missedScheduledCheck(local(22, 6), local(22, 1).getTime(), '10:00', 12, TZ)).toBe(false);
    });
});

describe('latestCheckMs (what armAutoSwgAutoCheck passes in on start)', () => {
    it('uses the saved last check when there has been no attempt in this process (the 2026-11-13 start: it must still find the missed 22:00 check)', () => {
        const last = latestCheckMs(local(10, 0, 1).toISOString(), 0);
        expect(last).toBe(local(10, 0, 1).getTime());
        expect(missedScheduledCheck(local(7, 8, 11, 13), last, '10:00', 12, TZ)).toBe(true);
    });

    it('takes the later of the saved check and an attempt, and ignores what is missing', () => {
        expect(latestCheckMs(local(10, 0, 1).toISOString(), local(22, 1).getTime())).toBe(local(22, 1).getTime());
        expect(latestCheckMs(local(22, 1).toISOString(), local(10, 0).getTime())).toBe(local(22, 1).getTime());
        expect(latestCheckMs(undefined, local(22, 1).getTime())).toBe(local(22, 1).getTime());
        expect(latestCheckMs(undefined, 0)).toBeUndefined();
        expect(latestCheckMs('not a date', undefined)).toBeUndefined();
    });
});
