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

// SWG Assist makes no change while super chlorinate is on: an apply then would change the setpoint under a run that ignores it, and would be logged as a
// change of the normal %. The automatic check, Auto-Apply, the step and Away are held (recorded as held in the history), and one check is made up after
// the run ends. Check Now still calculates and shows; applying it by hand is refused with the reason. The wiring is in web/services/state/State.ts.

export const SUPER_CHLOR_HELD = 'super chlorinate';
export const SUPER_CHLOR_HOLD_NOTE = 'Super chlorinate on; SWG Assist changes held until it ends.';
export const SUPER_CHLOR_APPLY_REFUSED = 'Super chlorinate is on, so SWG Assist changes are held until it ends (the run makes 100% whatever the % is set to, and a change now would be logged as a change of the normal %). Apply after it ends; an automatic check is made up then.';

// Super chlorinate is on for the chlorinator, unless it serves the spa only (a spa run is ignored, like the spa %). Body: 0 pool, 1 spa, 32 shared.
export function superChlorOn(chlorState: { superChlor?: boolean } | undefined, body?: number): boolean {
    return !!chlorState && chlorState.superChlor === true && body !== 1;
}

// What to do when the hold is looked at again (every few minutes, and at start): `hold` is the new state of the flag; `makeUp` is true once, when a run
// that held a change has ended (superChlorHeldAt is then cleared).
export function superChlorHoldUpdate(on: boolean, heldAt: string | undefined): { hold: boolean; makeUp: boolean; clearHeldAt: boolean } {
    const ended = !on && !!heldAt;
    return { hold: on, makeUp: ended, clearHeldAt: ended };
}

// The normal SWG % of the chlorinator: its target output, except during super chlorinate, when the output reads 100 while the setpoint keeps the
// normal % (so a held change, and the card, show the % the run will return to, not 100).
export function normalSwgPct(chlorState: { superChlor?: boolean; targetOutput?: number; poolSetpoint?: number } | undefined): number | undefined {
    if (!chlorState) return undefined;
    if (chlorState.superChlor === true && typeof chlorState.poolSetpoint === 'number') return chlorState.poolSetpoint;
    return chlorState.targetOutput;
}
