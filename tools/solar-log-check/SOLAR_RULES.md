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

All are in `config.json` under `controller.solar`. All but `coolAnyTime`, `returnHold`,
`returnHoldGain` and `blockFeature` are also on the heater
page of dashPanel under Solar Controls. A change takes effect on the next pass; no restart is needed.

| Setting | Default | What it does |
|---|---|---|
| `settleMinutes` | 5 | No start for this long after the pump starts or after solar turns off. A stop for the water waits this long too. 0 turns it off. |
| `hysteresis` | 0.5 | Solar stops at the setpoint plus this, and after such a stop restarts at the setpoint minus this. 0 turns it off. |
| `valveDelaySeconds` | 0 (off) | How long the pump runs at its solar speed, valve closed, before a start is judged (the check). 120 is a value to start with. |
| `checkPeriodMinutes` | 60 | After the check turns a start down, how long before the next check. |
| `returnSensor` | none | The temperature input on the pipe coming back from the panels. Shown and logged; with `returnHold` on it can keep a heating run going. One-body systems only. |
| `startMargin` | 2 | How much more than the run delta the collector must lead the water (warmer for heating, cooler for cooling) for a check to begin and pass. Room for the collector reading to move toward the water once water flows. |
| `minRunMinutes` | 5 | For this long after solar turns on, it is not stopped because the collector lead fell to the run delta. A collector no warmer (cooling: no cooler) than the water, and the water stop, still apply. |
| `coolAnyTime` | false | Nocturnal cooling may run at any hour, not only between sunset and sunrise. For testing; file only. See section 6. |
| `returnHold` | false | With a return sensor, a heating run continues past the collector stop while the return still delivers heat. File only. See section 6. |
| `returnHoldGain` | 0.5 | The return gain over the water, averaged over 5 minutes, that keeps a run going under `returnHold` (0.1 to 5). File only. |
| `blockFeature` | none | A feature, by id or name, that stands for a valve closing the collector off. While it is on, solar does not run. File only. See section 6. |

The start delta and the run delta are the heater's own settings (6 and 3 on this pool).

**Does a pool need the valve delay?** With solar off and the valve closed, note the water reading
at the normal pump speed. Switch the pump to the speed solar uses, wait two minutes, and note it
again. If the two differ by more than the hysteresis, turn the valve delay on: 120 seconds is a
value to start with, or the time the reading took to stop moving. If they do not differ, leave it
at 0. A pool whose pump does not change speed for solar does not need it.

**When to raise the hysteresis to 1.** Half a degree suits a reading that is steady to a few
tenths. Use 1 if solar still switches off and on around the setpoint within an hour, if the
reading moves by more than half a degree when the pump changes speed and the valve delay is not
in use, or if the sensor reports whole degrees.

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

### The reading expected at the solar pump speed

Each check that runs its full time records the difference between the two speeds: the reading at
the end of the check minus the reading when it began (about +1.5 on this pool). Two rules use it,
by adding it to the reading at the normal speed to get the reading expected at the solar speed.

- **When a check begins.** For heating, the start conditions of section 3 must hold, and with the
  expected reading the collector must still lead the water by more than the run delta and the
  water must still be below the stop level. Without this, a check began the moment the lead passed
  the run delta at the normal speed, was turned down at the solar speed, and the check period
  then kept solar off for an hour of good sun. For cooling, the start conditions must hold with
  the expected reading, so a reading that is too cool at the normal speed but warm enough at the
  solar speed does get its check.
- **Checking again before the check period is over.** After a turned-down start, the next check
  is allowed early when the expected reading passes with the hysteresis to spare and the settle
  delay has gone by since the pump slowed down. The difference used is the one the turned-down
  check itself measured.

**The first check after the pump starts.** Once the collector side alone would pass (the
collector more than the run delta warmer than the expected reading, or for nocturnal cooling, at
night, that much cooler; and the reheat guard met), one check is made whatever the water side
says. It gives the day a reading at the solar pump speed and re-measures the difference. If the
water side passes too, solar starts; if not, the check period applies as usual.

Until a first check has measured the difference it is taken as 0. With the valve delay in use,
solar is started by a check and by nothing else.

## 6. While solar runs, and when it stops

- **Water at the target.** Solar stops when the water has stayed at or above the setpoint plus
  the hysteresis for the whole settle delay. A dip below resets the count. If the water is past
  that level by a degree or more (and by more than the hysteresis), it stops at once; that is a
  changed setpoint, not the flow effect.
- **Collector too cool.** Solar stops when the collector's lead over the water falls to the run
  delta. This sets the reheat guard.
- **The return hold** (`returnHold`, off by default). The collector sensor reads the panels, not
  the heat they deliver, and the return can still be above the water when the lead reaches the
  run delta. With the hold on and a return sensor reading, a heating run goes on past that point
  while the return's gain over the water, averaged over the last 5 minutes, is at least
  `returnHoldGain` and the collector still leads the water by more than 1. It applies only once
  that average has come up to `returnHoldGain` after the start. The first 5 minutes of a run are
  left out of the average: the water that stood in the return pipe reaches the sensor first, cold
  in the morning and hot after sitting in the sun, and is not heat the panels deliver. It never starts solar and does not apply to cooling. The water stop
  still applies. When the hold ends, the stop is a collector stop and sets the reheat guard. With no
  return reading, or with the reading gone for a minute, the usual rule applies.
- **The block feature** (`blockFeature`, none by default). For a valve that keeps water out of the
  collector, closed for the winter or for work on the panels. Turn the named feature on when the
  valve is closed. While it is on, solar does not start, a running solar stops (no reheat guard is
  set: the collector did not cause it), and a valve delay check under way is cancelled. The heat
  mode is left as it is, so solar resumes by its usual rules once the feature is off. A setting
  that names no feature is warned about once and blocks nothing. The dashboard note reads
  "Solar off: <feature> is on".
- **A stop stands.** Once a stop is decided it is not judged again until the heater reports off.
  Before this rule, a new reading arriving while the relay switched could clear the reheat guard.
- After any stop the settle delay runs before the next start is considered.
- The reheat guard is for a cloud or a dip in the sun, so it does not outlast the day: it is
  cleared at sunset, and when the pump has started again since it was set (the pool was off, or
  the pump primed after a stop). An njsPC restart clears it too.

Nocturnal cooling follows the same rules with the directions reversed: it runs at night, the
collector must be cooler than the water, and the Cool Point is its target as the Heat Point is
heating's. It starts when the water is above the Cool Point, stops when the water falls to the
Cool Point minus the hysteresis, and after that stop restarts only above the Cool Point plus the
hysteresis. A change to the Heat Point, the Cool Point or the heat mode clears a stop at the target
and the reheat guard, so the new setting applies at the next check (upstream cleared them for the
Heat Point and heat mode only).

- **Changed from upstream.** Upstream (#925) cooled only while the water was above the Cool Point
  plus the run delta, so a Cool Point of 80 with a run delta of 3 stopped near 83. An existing
  Cool Point now cools about the run delta further.
- **Heating and cooling can both run.** With the Cool Point below the Heat Point plus the
  hysteresis, night cooling pulls the water under the level daytime heating restarts at, and the
  two undo each other every day. That is allowed, for whoever wants it; dashPanel shows a note
  beside the Cool Point when the setpoints are set that way.

- **At sunrise a cooling run ends.** The night is part of the rule that keeps it running, so it
  stops then as a plain stop: no reheat guard and no hysteresis wait.
- **`coolAnyTime`** lifts the night rule, for cooling only. It exists to test what the night
  cannot reach: a cooling run ended because the morning sun warms the collector until the water
  leads it by no more than the run delta (a collector stop, so the reheat guard is set at that
  collector reading), and heating after it, which may start only once the collector has risen more
  than the start delta above that reading. With it on, cooling also runs on any cool or cloudy day
  whose readings pass, so turn it off after the test. A Cool Point below the Heat Point then makes
  morning cooling and afternoon heating undo each other. Heating wins when both would run.

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
when it starts. While the status of a pump that serves the body is "priming":

- the solar settle delay does not count; it starts when priming ends;
- so no check begins during priming, and the readings a check goes by are never priming readings.

With priming at 3 minutes and the settle delay at 5, the first check after a pump start begins
about 8 minutes after the start.

Priming is off unless it is turned on for the pump. The solar branch does not need the priming
branch: without it no pump reports "priming" and the rule above does nothing.

A pump serves the body when one of its circuits is the body's circuit, or, for a pump with no
circuits, when the body it is set to is that body.

## 9. The return sensor

If `returnSensor` names an input, its reading is shown on the body card as Solar Return, and
while solar runs the gain over the water going in is shown. The return and its gain are logged
with the other readings when solar turns on or off and every five minutes while it runs. A reading of exactly 0, or
one more than 60 degrees from the water, counts as no sensor. It takes no part in the decision
unless `returnHold` is on (section 6).

The setting is offered only on a system with one body. With more bodies, solar sensors 2 to 4
are the collector sensors of the other bodies.

## 10. The same scenarios, as they look in the solar log

- **A check that starts solar:** "a start looks worthwhile", then "still worthwhile after 120 s",
  then "switching on" and "on command confirmed".
- **A check that is turned down:** "a start looks worthwhile", then "not started: after 120 s",
  then a settle delay line "after the valve delay check turned the start down" once a minute.
- **A stop for the collector:** "turned off because the collector lead over the water fell to the
  run delta", with the reheat guard and the level the collector must reach.
- **A stop for the water:** "turned off because the water was at or above" the stop level.
- **While solar runs:** every five minutes a line "Solar ... heating" (or "cooling") with the water,
  the collector and its lead over the water, and with a return sensor, the return and its gain.
- **The return hold:** "kept running by the return" when it keeps a run going past the collector
  stop; the five-minute lines then end "kept running by the return"; and "the return hold ended
  after N min" with the change in the water and the reason.
- **The block feature:** "blocked: the feature ... is on" when it comes on, "turned off because the
  feature ... is on" if solar was running, and "no longer blocked" when it goes off.

`solar_log_check.py` in this folder reads these lines and reports the runs, what held solar off
and for how long, and what each check did.


## 11. Other heaters on the same body

These rules are for a solar heater njsPC controls itself (a Nixie or REM heater), in the Solar
and Solar Preferred heat modes. Heaters an outdoor control panel runs are not touched, and the
rules for gas, heat pump, UltraTemp, hybrid and MasterTemp heaters are as upstream. njsPC goes
through a body's heaters solar first and stops at the first one that runs. Where solar meets the
others:

- **A pending solar start holds back the backup heater.** In Solar Preferred, while solar waits
  out the settle delay, or its valve delay check runs or has decided to start, a gas, MasterTemp
  or hybrid heater after it is not started. Without these delays solar would have started at once
  and the backup heater would not have run. One that is already running stays on until solar
  starts, so it is not stopped and started around each check. After a check turns a start down
  the backup heater may run through the check period, since solar is not expected to run then.
- **Nocturnal cooling keeps clear of a backup heater.** When another heater can heat the body in
  the current heat mode (gas in Solar Preferred, which heats its Stop Temp Delta past the Heat
  Point; MasterTemp, to the Heat Point; hybrid in any mode, 1 past it), cooling works to no lower
  than the highest level that heater heats to plus the hysteresis, in place of a lower Cool Point.
  Cooling then never starts at the level that heater leaves the water at, and never takes the
  water under the Heat Point, where that heater would start again; otherwise the two would take
  turns all night. The dashboard note and dashPanel's "cooling stops at" label say so when it
  applies. On a body heated by solar only the Cool Point is used as set.
- **The note on why solar is waiting** is not shown while another heater heats the body.
- **Heat pumps and UltraTemp** cool to the same Cool Point in their own heat modes. Solar never
  runs in those modes, so the two do not meet.
- **dashPanel** lists in Solar Controls only the bodies a solar heater serves. A body that also
  has another heater keeps its Cool Point at least the Heat Point + 1, as the Heat Settings popup
  does; on a body heated by solar only it may be lower.
