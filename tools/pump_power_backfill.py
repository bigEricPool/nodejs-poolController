#!/usr/bin/env python3
"""Fills data/pumpPowerLog.jsonl for the time before pump power tracking was installed, from njsPC's console logs.

njsPC logs at level info when a pump's relays change ("NCP: Setting Pump <name> relays to Relay 1: on, Relay 2: off.") and when a
circuit is set ("NCP: Setting Circuit <name> to true"). This replays those lines against the pumpPower settings in config.json, so
the speeds, their relays and the rule for choosing (the speed with the most watts among those that apply) are the same as in
controller/PumpPower.ts. A speed's connection and device are matched to a pump relay or a circuit in data/poolConfig.json, so enter
the speeds in the Pump Power settings first.

Run it from the njsPC folder. It changes nothing unless --write is given:
    python3 tools/pump_power_backfill.py                 prints what it would add, by day
    python3 tools/pump_power_backfill.py --write         adds it to the log, once; njsPC shows it after its next restart

Time counts only while the log is being written: a stretch with no line longer than --gap seconds (njsPC stopped) counts as nothing,
and is reported. Only time before the log's first hour is added, so nothing is counted twice.
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime

HOUR = 3600
LINE = re.compile(r'^\[(\d\d)/(\d\d)/(\d{4}), (\d\d):(\d\d):(\d\d)\]')
PUMP = re.compile(r'NCP: Setting Pump (.+?) relays to (Relay \d: (?:on|off)(?:, (?:and )?Relay \d: (?:on|off))*)')
RELAY = re.compile(r'Relay (\d): (on|off)')
CIRCUIT = re.compile(r'NCP: Setting Circuit (.+) to (true|false)\s*$')
BOOT = 'Initializing Nixie circuit'


def load_speeds(root):
    """The pumps to replay: {pump name: {id, speeds: [{id, name, watts, relays, circuits, default}]}}."""
    with open(os.path.join(root, 'config.json'), encoding='utf-8-sig') as f:
        settings = json.load(f).get('pumpPower') or {}
    with open(os.path.join(root, 'data', 'poolConfig.json'), encoding='utf-8-sig') as f:
        pool = json.load(f)
    same = lambda o, s: o.get('connectionId') == s.get('connectionId') and o.get('deviceBinding') == s.get('deviceBinding')
    pumps = {}
    for entry in settings.get('pumps') or []:
        pump = next((p for p in pool.get('pumps') or [] if p.get('id') == entry.get('pump')), None)
        if pump is None:
            sys.exit('Pump %s in the settings is not in poolConfig.json.' % entry.get('pump'))
        speeds = []
        for s in entry.get('speeds') or []:
            bound = bool(s.get('connectionId') and s.get('deviceBinding'))
            relays = [r.get('id', i + 1) for i, r in enumerate(pump.get('relays') or []) if bound and same(r, s)]
            circuits = [c.get('name') for c in pool.get('circuits') or [] if bound and same(c, s)]
            if bound and not relays and not circuits:
                print('Warning: no pump relay or circuit uses the relay set for %s, so it will never count.' % s.get('name'))
            speeds.append({'id': s['id'], 'name': s.get('name'), 'watts': s.get('watts') or 0, 'relays': relays, 'circuits': circuits, 'default': not bound})
        if speeds:
            pumps[pump.get('name')] = {'id': pump.get('id'), 'speeds': speeds}
    if not pumps:
        sys.exit('No pump has speeds in the pumpPower section of config.json: enter them in the Pump Power settings first.')
    return pumps


def speed_now(pump, relays_on, circuits_on):
    """As pumpSpeedNow in PumpPower.ts: a speed's id, 0 when on with no speed that applies, -1 when off."""
    pump_on = len(relays_on) > 0
    best = None
    for s in pump['speeds']:
        on = pump_on if s['default'] else any(r in relays_on for r in s['relays']) or any(c in circuits_on for c in s['circuits'])
        if on and (best is None or s['watts'] > best['watts']):
            best = s
    if best:
        return best['id']
    return 0 if pump_on else -1


def log_files(folders):
    """The console logs, oldest first. A file in two folders is read once; the running log comes last."""
    found = {}
    for folder in folders:
        for path in glob.glob(os.path.join(os.path.expanduser(folder), 'njsPC-out*.log')):
            found.setdefault(os.path.basename(path), path)
    return [found[n] for n in sorted(found, key=lambda n: (n == 'njsPC-out.log', n))]


def first_logged_hour(path):
    first = None
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                try:
                    t = json.loads(line)['t'] / 1000
                except (ValueError, KeyError, TypeError):
                    continue
                first = t if first is None else min(first, t)
    return first


class Replay:
    def __init__(self, pumps, until, gap):
        self.pumps, self.until, self.gap = pumps, until, gap
        self.relays = {name: set() for name in pumps}
        self.circuits = set()
        self.last = None
        self.first = None
        self.hours = {}         # {(hour start, pump name): {speed id or 'off': seconds}}
        self.gaps = []          # (start, seconds)
        self.run = {}           # {(pump name, speed id): [run start, longest run]}

    def credit(self, start, end):
        for name, pump in self.pumps.items():
            sid = speed_now(pump, self.relays[name], self.circuits)
            key = 'off' if sid < 0 else str(sid)
            t = start
            while t < end:
                hour = int(t // HOUR * HOUR)
                part = min(end, hour + HOUR) - t
                row = self.hours.setdefault((hour, name), {})
                row[key] = row.get(key, 0) + part
                t += part
            r = self.run.setdefault((name, key), [None, 0])
            if r[0] is None:
                r[0] = start
            r[1] = max(r[1], end - r[0])
            for other, v in self.run.items():
                if other[0] == name and other[1] != key:
                    v[0] = None

    def line(self, text):
        m = LINE.match(text)
        if not m:
            return
        d, mo, y, h, mi, s = [int(v) for v in m.groups()]
        now = datetime(y, mo, d, h, mi, s).timestamp()
        if now >= self.until:
            return
        if self.first is None:
            self.first = now
        if self.last is not None and now > self.last:
            if now - self.last > self.gap:
                self.gaps.append((self.last, now - self.last))
            else:
                self.credit(self.last, now)
        self.last = max(now, self.last or now)
        if BOOT in text:
            # njsPC started: its pump relays are all off until the pump line that follows.
            for name in self.relays:
                self.relays[name] = set()
            return
        p = PUMP.search(text)
        if p:
            if p.group(1) in self.relays:
                self.relays[p.group(1)] = {int(n) for n, v in RELAY.findall(p.group(2)) if v == 'on'}
            return
        c = CIRCUIT.search(text)
        if c:
            if c.group(2) == 'true':
                self.circuits.add(c.group(1))
            else:
                self.circuits.discard(c.group(1))


def report(replay):
    names = {}
    for name, pump in replay.pumps.items():
        names[name] = {str(s['id']): s for s in pump['speeds']}
    days = {}
    for (hour, name), row in replay.hours.items():
        day = datetime.fromtimestamp(hour).strftime('%Y-%m-%d')
        d = days.setdefault((day, name), {})
        for k, v in row.items():
            d[k] = d.get(k, 0) + v
    total = 0
    for (day, name) in sorted(days):
        d, kwh, parts = days[(day, name)], 0, []
        for k, s in names[name].items():
            kwh += d.get(k, 0) * s['watts'] / 3600000
            parts.append('%s %.1f h' % (s['name'], d.get(k, 0) / 3600))
        parts.append('off %.1f h' % (d.get('off', 0) / 3600))
        if d.get('0'):
            parts.append('no speed %.1f h' % (d['0'] / 3600))
        total += kwh
        print('%s  %6.2f kWh  %s' % (day, kwh, ', '.join(parts)))
    print('Total %.1f kWh' % total)
    print('Longest runs: ' + ', '.join('%s %.1f h' % (names[n][k]['name'], r[1] / 3600) for (n, k), r in sorted(replay.run.items()) if k in names[n]))
    when = lambda t: datetime.fromtimestamp(t).strftime('%m-%d %H:%M')
    print('Log gaps counted as nothing: %d, %.1f h in all' % (len(replay.gaps), sum(g[1] for g in replay.gaps) / 3600))
    for start, sec in sorted(replay.gaps, key=lambda g: -g[1])[:10]:
        print('  %s for %.1f min' % (when(start), sec / 60))


def rows(replay):
    out = []
    for (hour, name), row in sorted(replay.hours.items()):
        s = {k: int(round(v)) for k, v in row.items() if k != 'off'}
        out.append(json.dumps({'t': hour * 1000, 'p': replay.pumps[name]['id'], 's': s, 'off': int(round(row.get('off', 0)))}, separators=(',', ':')))
    return out


def main():
    ap = argparse.ArgumentParser(description='Fills the pump power log from njsPC console logs.')
    ap.add_argument('--root', default='.', help='the njsPC folder')
    ap.add_argument('--logs', action='append', help='a folder of njsPC-out logs (default ~/njsPC-logs-keep and ~/.pm2/logs)')
    ap.add_argument('--gap', type=float, default=120, help='seconds without a log line that count as njsPC stopped (default 120)')
    ap.add_argument('--write', action='store_true', help='add to the log; without this nothing is changed')
    a = ap.parse_args()
    pumps = load_speeds(a.root)
    target = os.path.join(a.root, 'data', 'pumpPowerLog.jsonl')
    marker = target + '.backfilled'
    if a.write and os.path.exists(marker):
        sys.exit('The backfill was already added (%s).' % marker)
    first = first_logged_hour(target)
    until = first if first is not None else datetime.now().timestamp()
    files = log_files(a.logs or ['~/njsPC-logs-keep', '~/.pm2/logs'])
    if not files:
        sys.exit('No njsPC-out logs found.')
    replay = Replay(pumps, until, a.gap)
    for path in files:
        with open(path, encoding='utf-8', errors='replace') as f:
            for text in f:
                replay.line(text)
    if replay.first is None:
        sys.exit('The logs hold nothing before ' + datetime.fromtimestamp(until).strftime('%Y-%m-%d %H:%M'))
    print('%d log files, %s to %s' % (len(files), datetime.fromtimestamp(replay.first).strftime('%Y-%m-%d %H:%M'), datetime.fromtimestamp(replay.last).strftime('%Y-%m-%d %H:%M')))
    report(replay)
    lines = rows(replay)
    if not a.write:
        print('Nothing written: add --write to add these %d lines.' % len(lines))
        return
    with open(target, 'a', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    with open(marker, 'w', encoding='utf-8') as f:
        f.write(datetime.now().isoformat() + '\n')
    print('Added %d lines to %s. njsPC shows them after its next restart.' % (len(lines), target))


if __name__ == '__main__':
    main()
