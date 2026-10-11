# Solar rules

How the solar heating decision works on the `feature/solar-enhancements` branch, in plain language.
It covers a Nixie (njsPC as the controller) pool whose solar heater is a valve on a relay and whose
pump runs faster when solar is on. The code is in `HeaterCommands.syncHeaterStates` in
`controller/boards/SystemBoard.ts`.

Temperatures below are in degrees Fahrenheit and come from one pool: a two speed pump, a water
sensor on the pipe at the equipment pad, and a collector sensor in the air beside the panels.

## 1. Why any of this is needed: one pool, three readings

The water sensor does not read the same water temperature at every pump speed. On this pool, with
the water itself unchanged:

| Pump and valve | Reading |
|---|---|
| Low speed, valve closed | about 84.2 |
| Solar (high) speed, valve closed | about 85.7 |
| Solar speed, valve open, after the first minute | about 85.1 |

The likely reason is that the pump draws from the main drain and the skimmer, and takes a
different mix of the two at a different speed. The difference is steady. It is not noise and it
does not settle out.

Solar runs at the solar speed, so its setpoint has to be judged against a reading taken at that
speed. A start judged at low speed sees 84.2, opens the valve, then sees 85.7 and may be over the
setpoint at once. Without the rules below that produces short starts, over and over.

## 2. Settings

All are in `config.json` under `controller.solar`, and on the heater page of dashPanel under
Solar Controls. A change takes effect on the next pass; no restart is needed.

| Setting | Default | What it does |
|---|---|---|
| `settleMinutes` | 5 | No start for this long after the pump starts or after solar turns off. A stop for the water waits this long too. 0 turns it off. |
| `hysteresis` | 1 | Solar stops at the setpoint plus this, and after such a stop restarts at the setpoint minus this. 0 turns it off. |
| `valveDelaySeconds` | 120 | How long the pump runs at its solar speed, valve closed, before a start is judged (the check). 0 turns the check off. |
| `checkPeriodMinutes` | 60 | After the check turns a start down, how long before the next check. |
| `returnSensor` | none | The temperature input on the pipe coming back from the panels. Shown and logged only. |

The start delta and the run delta are the heater's own settings (6 and 3 on this pool).

## 3. When a start is considered

At the normal pump speed, a start is considered when all of these hold:

1. The collector is warmer than the water by more than the run delta.
2. The water is below the setpoint. After a stop at the target it must be below the setpoint
   minus the hysteresis.
3. If the last stop was caused by the collector, the collector has risen more than the start
   delta above where it was at that stop (the reheat guard).
4. No wait is in force: the settle delay after the pump started or after solar turned off, the
   check period after a turned-down start, or the 60 second short-cycle protection.

Meeting these does not open the valve. It starts the check.

## 4. The check

1. The body's solar circuit turns on, so the pump goes to its solar speed. The valve stays closed.
2. Nothing is decided for `valveDelaySeconds`. The reading moves in the first seconds after the
   pump speeds up, and a decision made then was the fault in the first version of this feature.
3. When the delay is over the start is judged once, with the reading at the solar speed:
   - the collector must still lead the water by more than the run delta, and the reheat guard
     must still be met;
   - the water must be below the level solar would stop at, which is the setpoint plus the
     hysteresis. A start is not turned down for water that solar, once running, would not stop
     for.
4. If it passes, the valve relay is switched on. The decision stands until the heater reports on,
   so a pass made while the relay is switching cannot undo it.
5. If it fails, the pump goes back to its normal speed and the start is turned down.

## 5. The check period

After a turned-down start the next check waits `checkPeriodMinutes` (never less than the settle
delay or the valve delay). The pump is not sped up to test the water more often than that.

A change of setpoint is checked at once. A restart of njsPC forgets a turned-down start.

Solar is not on a timer. The check runs only when a start is called for by the readings at the
normal speed. When the water is well above the setpoint there are no checks at all.

## 6. While solar runs, and when it stops

- **Water at the target.** Solar stops when the water has stayed at or above the setpoint plus
  the hysteresis for the whole settle delay. A dip below resets the count. If the water is past
  that level by a degree or more (and by more than the hysteresis), it stops at once; that is a
  changed setpoint, not the flow effect.
- **Collector too cool.** Solar stops when the collector's lead over the water falls to the run
  delta. This sets the reheat guard.
- **A stop stands.** Once a stop is decided it is not judged again until the heater reports off.
  Before this rule, a new reading arriving while the relay switched could clear the reheat guard.
- After any stop the settle delay runs before the next start is considered.

Nocturnal cooling follows the same rules with the directions reversed: it runs at night, the
collector must be cooler than the water, and the stop level is the cool setpoint plus the run
delta minus the hysteresis.

## 7. What the dashboard shows as the pool temperature

The aim is that the number shown is the one solar is working from, and that it does not jump
about with the pump speed.

| Situation | Shown | Marked |
|---|---|---|
| Normal running, nothing below applies | the live reading | time of the latest reading |
| A check is under way | what was shown before the check began; it does not follow the reading up | as before |
| A check turned the start down | the reading at the solar speed that the check went by, until the next check replaces it | `*` and "as of" the time of the check |
| Solar is running | the live reading | time of the latest reading |
| Solar has turned off | the last reading taken while it ran, for the check period at most | `*` and "as of" that time |
| A new check starts while a marked reading is shown | the marked reading stays through the check | `*` |

A change of setpoint does not drop the display back to the low speed reading.

The body card also shows a short note on what solar is waiting for, for example "Solar check in
45 s", "Solar waiting to start: 12 min left after the valve delay check turned the start down",
or "Solar waiting: the collector must reach 94.9".

## 8. Pump priming

Priming (the `feature/pump-priming` branch) runs a relay pump at its high speed for a few minutes
when it starts. While a pump's status is "priming":

- the solar settle delay does not count; it starts when priming ends;
- so no check begins during priming, and the readings a check goes by are never priming readings.

With priming at 3 minutes and the settle delay at 5, the first check after a pump start begins
about 8 minutes after the start.

Priming is off unless it is turned on for the pump. The solar branch does not need the priming
branch: without it no pump reports "priming" and the rule above does nothing.

## 9. The return sensor

If `returnSensor` names an input, its reading is shown on the body card as Solar Return, and
while solar runs the gain over the water going in is shown and logged. A reading of exactly 0, or
one more than 60 degrees from the water, counts as no sensor. It takes no part in the decision.

## 10. The same scenarios, as they look in the solar log

- **A check that starts solar:** "a start looks worthwhile", then "still worthwhile after 120 s",
  then "switching on" and "on command confirmed".
- **A check that is turned down:** "a start looks worthwhile", then "not started: after 120 s",
  then a settle delay line "after the valve delay check turned the start down" once a minute.
- **A stop for the collector:** "turned off because the collector lead over the water fell to the
  run delta", with the reheat guard and the level the collector must reach.
- **A stop for the water:** "turned off because the water was at or above" the stop level.

`solar_log_check.py` in this folder reads these lines and reports the runs, what held solar off
and for how long, and what each check did.
