// Express answers a request with the first route that matches, so the fixed chlorinator paths must be registered before
// GET /state/chlorinator/:id, which would otherwise take 'outputLog' and 'usage' as a chlorinator id.
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../../web/services/state/State.ts'), 'utf8');
const at = (route: string) => src.indexOf(`app.get('${route}'`);

describe('state chlorinator routes', () => {
    it('registers outputLog and usage before the :id route', () => {
        const id = at('/state/chlorinator/:id');
        expect(id).toBeGreaterThan(0);
        for (const r of ['/state/chlorinator/outputLog', '/state/chlorinator/usage']) {
            expect(at(r)).toBeGreaterThan(0);
            expect(at(r)).toBeLessThan(id);
        }
    });
});
