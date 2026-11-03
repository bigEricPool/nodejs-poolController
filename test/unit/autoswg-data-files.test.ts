// Moving SWG Assist's data files to the names the pool's logging feature uses (controller/AutoSwgDataFiles.ts), in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { moveDataFile } from '../../controller/AutoSwgDataFiles';

const LINE = '{"t":"2026-07-01T12:00:00.000Z","n":6}\n';
let dir: string, from: string, to: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datafiles-'));
    from = path.join(dir, 'autoSwgOutputLog.jsonl');
    to = path.join(dir, 'chlorinatorOutputLog.jsonl');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('moveDataFile', () => {
    it('copies the file under the new name and keeps the old one as .bak', () => {
        fs.writeFileSync(from, LINE);
        expect(moveDataFile(from, to)).toBe('moved');
        expect(fs.readFileSync(to, 'utf8')).toBe(LINE);
        expect(fs.existsSync(from)).toBe(false);
        expect(fs.readFileSync(`${from}.bak`, 'utf8')).toBe(LINE);
        expect(fs.existsSync(`${to}.tmp`)).toBe(false);
    });
    it('does nothing when there is no old file', () => {
        expect(moveDataFile(from, to)).toBe('none');
        expect(fs.existsSync(to)).toBe(false);
    });
    it('never overwrites a file that already has the new name', () => {
        fs.writeFileSync(from, 'old');
        fs.writeFileSync(to, 'new');
        expect(moveDataFile(from, to)).toBe('kept');
        expect(fs.readFileSync(to, 'utf8')).toBe('new');
        expect(fs.readFileSync(from, 'utf8')).toBe('old');
        expect(fs.existsSync(`${from}.bak`)).toBe(false);
    });
    it('checks that a .json file parses before it moves it', () => {
        const j = path.join(dir, 'autoSwgPoolMathArchive.json'), k = path.join(dir, 'poolMathArchive.json');
        fs.writeFileSync(j, '{"entries":[');
        expect(moveDataFile(j, k)).toBe('failed');
        expect(fs.existsSync(k)).toBe(false);
        expect(fs.existsSync(`${k}.tmp`)).toBe(false);
        expect(fs.existsSync(j)).toBe(true);
        expect(fs.existsSync(`${j}.bak`)).toBe(false);
    });
});
