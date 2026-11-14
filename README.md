# nodejs-poolController (bigEricPool fork)

This fork of [tagyoureit/nodejs-poolController](https://github.com/tagyoureit/nodejs-poolController) holds one branch per feature and one per bug fix, each cut from the original project's `master` so it can be offered upstream on its own. The branch `pool` contains all of them together. The companion fork is [bigEricPool/nodejs-poolController-dashPanel](https://github.com/bigEricPool/nodejs-poolController-dashPanel).

This page is the list of branches. `manifest.json` holds the same list for the build check, which runs `npm ci` and `npm run build` on every branch marked to build.

Base for new branches: master at 10.1.0 (2e7c1efb).

## In use

| Branch | Kind | Purpose | Depends on | Related report |
|---|---|---|---|---|
| `master` | mirror | Untouched copy of the original project's master. Every module and fix branch is cut from it. | none | none |
| `pool` | integration | Everything together; the branch the pool controller runs. To be built from the branches below, never edited directly. | all module and fix branches | none |
| `pool-next` | integration | pool rebuilt from the branches in this list, in a fixed order. It is replaced at every rebuild; pool takes it over after testing. | all module and fix branches | none |
| `fix/schedule-restart` | fix | Sunrise/sunset schedules after a restart: relay re-trigger at boot, heat setpoint re-push, sunset window, failed window cache, heliotrope init. | none | tagyoureit/nodejs-poolController#1247 (open) |
| `fix/solar-restart` | fix | Solar after a restart and near the setpoint: reheat guard cleared at boot, water temperature truncation, virtual-circuit boot reset. | none | tagyoureit/nodejs-poolController#1248 (open) |
| `fix/chlorinator-poll-stall` | fix | Nixie chlorinator polling restarts when the serial port reopens; a poll cycle is limited. | none | tagyoureit/nodejs-poolController#1255 (open) |
| `fix/nonblocking-state-save` | fix | poolState and poolConfig are saved without blocking the process, so slow storage cannot stop relay refreshes. | none | follows upstream #1240; not yet reported |
| `fix/heater-command-inflight` | fix | One command at a time per Nixie heater. | none | related: relayEquipmentManager#126 |
| `feature/chlorinator-rs485-diag` | feature | RS485 diagnostic view of chlorinator messages in both directions, with the Details popup. | none | tagyoureit/nodejs-poolController#1250 (closed) |
| `feature/chlorinator-log` | feature | Chlorinator logging: an hourly output log for every chlorinator, cell usage (lb of chlorine made, full-output hours, run hours) with per-chlorinator cellLbsPerDay and cellInstalledDate, and a PoolMath history import (poolMath section in poolConfig.json). Cut from upstream master, intended for upstream; SWG Assist builds on it. | none | none |
| `feature/temp-average-24h` | feature | 24 hour average water temperature for each body. | none | none |
| `feature/pump-status-log` | feature | At log level verbose, why and when a relay pump's status changes. | none | none |
| `feature/pump-priming` | feature | Priming for relay driven pumps (two speed, relay switched variable speed); off by default. | none | none |
| `feature/pws-weather` | feature | Hourly weather log from a personal weather station, and a Weather panel. | none | none |
| `feature/solar-enhancements` | feature | Solar log, settle delay, hysteresis, valve delay check, check period, return sensor, Solar Controls; in dashPanel also the Nocturnal Cooling toggle. Stacked on fix/solar-restart in njsPC. | fix/solar-restart, optional: feature/pump-priming, optional: fix/heater-command-inflight | #1248 |
| `feature/pi-status` | feature | The condition of the computer njsPC runs on: processor temperature, power and heat flags, processor and memory use, free storage, Wi-Fi signal, uptime, installed software, and how late njsPC itself runs, with a longer log (njsPC: GET /state/system). dashPanel: a System panel showing it. | none | none |
| `feature/power-tracking` | feature | Power usage for relay driven pumps: time at each speed times the watts set for it. Off by default. Adds a Pump Power panel in dashPanel. | none | none |
| `feature/power-pump-speeds` | feature | Pump power speeds set on each pump relay (name, rpm, watts, priority), power tracking per pump, warnings for missing settings; moves the old config.json pumpPower speeds onto the relays once. | feature/power-tracking | none |
| `feature/swg-bench` | feature | SWG Assist Model Bench: scores alternative projection models against the FC tests, replay and simulator; reads logs, writes only its own files, never changes the SWG %. | feature/swg-assist | none (fork only) |
| `feature/swg-bench-wiring` | feature | Feeds the bench the weather log, water temperature history and hourly pump power. Based on pool itself; merging it brings feature/swg-bench in. | feature/swg-bench, feature/pws-weather, feature/temp-average-24h, feature/power-tracking | none (fork only) |
| `feature/historyPanel` | feature | History registry and routes for the dashboard History panel (temperature, chlorinator, PoolMath sources). Built through feature/historyPanel-swg-assist. | feature/chlorinator-log, feature/temp-average-24h | none |
| `feature/historyPanel-swg-assist` | feature | feature/historyPanel plus SWG Assist's projected FC and FC range as a History source; the branch pool takes. Fork only. | feature/historyPanel, feature/swg-assist | none (fork only) |
| `local/pi-tools` | local | Backup, log trim and post-boot check scripts for the controller. Not for upstream. | none | none |
| `local/npm` | local | package.json allowScripts and the audit-fix lock file. Not for upstream. | none | none |

## Parked (kept out of pool)

| Branch | Kind | Purpose | Depends on | Related report |
|---|---|---|---|---|

## Planned (not created yet)

| Branch | Kind | Purpose | Depends on | Related report |
|---|---|---|---|---|
| `feature/swg-assist` | feature | SWG Assist: a recommended SWG % from PoolMath readings, with Away protection and the FC range control mode. User-facing text says SWG Assist; code, the autoSwg config key, data files and API routes keep the internal name AutoSwg. In pool and pool-next. | optional: fix/chlorinator-poll-stall | none |

## Being replaced

| Branch | Kind | Purpose | Depends on | Related report |
|---|---|---|---|---|
| `archive/2026-11-13/fix/schedule-defects` | archive | Older combined branch; replaced by fix/schedule-restart and fix/solar-restart. Its Cool Point change (#1249) is in upstream 10.0.2. | none | #1247, #1248, #1249 |
| `archive/2026-11-13/feature/dashboard-enhancements` | archive | Older combined branch; replaced by feature/chlorinator-rs485-diag and, in dashPanel, feature/dashboard-sun-times. | none | #1250 |

## Kept for history

| Branch | Kind | Purpose | Depends on | Related report |
|---|---|---|---|---|
| `archive/2026-11-13/audit-fix-pi` | archive | Snapshot of an earlier install; fully contained in pool. | none | none |
| `archive/2026-11-13/feature/solar-log` | archive | Old name of feature/solar-enhancements; contained in it. | none | none |
| `archive/2026-10-11/*` | archive | Tips of branches as they were before being re-cut on current master on 2026-10-11. | none | none |
| `archive/2026-11-03/*` | archive | Old AutoSwg branch names (feature/auto-swg, -tools, -automation, -clean), moved here on 2026-11-03, and feature/swg-cell-usage, whose content moved to feature/chlorinator-log and feature/swg-assist; their content is in feature/swg-assist and pool. | none | none |
| `archive/2026-11-03/docs/autoswg-drafts` | archive | Drafts of the AutoSwg guide, advanced modes and release notes (tools/autoswg-check/). Unique work, not in pool: keep until the SWG Assist release notes and wiki are written. | none | none |
| `archive/2026-11-05/feature/solar-nocturnal-cooling-check` | archive | The parked nocturnal cooling check (91ffc271), moved here on 2026-11-05: superseded by the speed-offset check rules of 2026-10-12, which are in feature/solar-enhancements and pool. Never run. | none | none |

The code in this fork and this page are written with the help of an AI assistant (Claude) and reviewed and run by the owner.
