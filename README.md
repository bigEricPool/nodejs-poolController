# nodejs-poolController (bigEricPool fork)

This fork of [tagyoureit/nodejs-poolController](https://github.com/tagyoureit/nodejs-poolController) holds one branch per feature and one per bug fix, each cut from the original project's `master` so it can be offered upstream on its own. The branch `pool` contains all of them together. The companion fork is [bigEricPool/nodejs-poolController-dashPanel](https://github.com/bigEricPool/nodejs-poolController-dashPanel).

This page is the list of branches. `manifest.json` holds the same list for the build check, which runs `npm ci` and `npm run build` on every branch marked to build.

Base for new branches: master at 10.0.2 (34c324cd).

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
| `feature/temp-average-24h` | feature | 24 hour average water temperature for each body. | none | none |
| `feature/pump-status-log` | feature | At log level verbose, why and when a relay pump's status changes. | none | none |
| `feature/pump-priming` | feature | Priming for relay driven pumps (two speed, relay switched variable speed); off by default. | none | none |
| `feature/pws-weather` | feature | Hourly weather log from a personal weather station, and a Weather panel. | none | none |
| `feature/solar-enhancements` | feature | Solar log, settle delay, hysteresis, valve delay check, check period, return sensor, Solar Controls; in dashPanel also the Nocturnal Cooling toggle. Stacked on fix/solar-restart in njsPC. | fix/solar-restart, optional: feature/pump-priming, optional: fix/heater-command-inflight | #1248 |
| `feature/auto-swg` | feature | AutoSwg: a recommended SWG % from PoolMath readings, with Away protection. AutoSwg code only. The tagged releases autoswg-v0.1.x are the earlier form of this branch. | optional: fix/chlorinator-poll-stall | none |
| `feature/auto-swg-tools` | feature | tools/autoswg-check and the AutoSwg documents. | feature/auto-swg | none |
| `local/pi-tools` | local | Backup, log trim and post-boot check scripts for the controller. Not for upstream. | none | none |
| `local/npm` | local | package.json allowScripts and the audit-fix lock file. Not for upstream. | none | none |

## Parked (kept out of pool)

| Branch | Kind | Purpose | Depends on | Related report |
|---|---|---|---|---|
| `feature/solar-nocturnal-cooling-check` | feature | A nocturnal cooling check is also made when the water would qualify at the solar pump speed. New behaviour, not yet run; to be looked at again later. | feature/solar-enhancements | none |
| `feature/pi-status` | feature | GET /state/system: the condition of the computer njsPC runs on (temperature, throttling, load, memory, storage, uptime). New, not yet run. | none | none |

## Planned (not created yet)

| Branch | Kind | Purpose | Depends on | Related report |
|---|---|---|---|---|
| `feature/swg-assist` | feature | feature/auto-swg plus the rename to SWG Assist (user-facing text only). | feature/auto-swg | none |

## Being replaced

| Branch | Kind | Purpose | Depends on | Related report |
|---|---|---|---|---|
| `fix/schedule-defects` | fix | Older combined branch; replaced by fix/schedule-restart and fix/solar-restart. Its Cool Point change (#1249) is in upstream 10.0.2. | none | #1247, #1248, #1249 |
| `feature/dashboard-enhancements` | feature | Older combined branch; replaced by feature/chlorinator-rs485-diag and, in dashPanel, feature/dashboard-sun-times. | none | #1250 |
| `feature/auto-swg-clean` | feature | Earlier AutoSwg-only branch; replaced by feature/auto-swg. | none | none |
| `feature/auto-swg-automation` | feature | Former working branch (AutoSwg plus solar, average, tools). Kept for history; no new work. | none | none |

## Kept for history

| Branch | Kind | Purpose | Depends on | Related report |
|---|---|---|---|---|
| `audit-fix-pi` | archive | Snapshot of an earlier install; fully contained in pool. | none | none |
| `feature/solar-log` | archive | Old name of feature/solar-enhancements; contained in it. | none | none |
| `archive/2026-10-11/*` | archive | Tips of branches as they were before being re-cut on current master on 2026-10-11. | none | none |
| `docs/autoswg-drafts` | archive | Drafts of the AutoSwg guide and release notes. | none | none |

The code in this fork and this page are written with the help of an AI assistant (Claude) and reviewed and run by the owner.
