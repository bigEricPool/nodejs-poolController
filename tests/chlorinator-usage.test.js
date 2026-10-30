// Run with: node --test -r ts-node/register tests/chlorinator-usage.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { chlorinatorUsageHours } = require('../controller/ChlorinatorUsage');
const start = 1700000000000;
const hour = 3600000;

test('50% for an hour accumulates half an equivalent hour from regular samples', () => {
    let total = 0;
    for (let elapsed = 0; elapsed < hour; elapsed += 10000) {
        total += chlorinatorUsageHours(50, 50, start + elapsed, start + elapsed + 10000, start);
    }
    assert.ok(Math.abs(total - 0.5) < 1e-12);
});

test('a gap averages the last and current output over the entire interval', () => {
    assert.equal(chlorinatorUsageHours(20, 80, start, start + hour, start), 0.5);
    assert.equal(chlorinatorUsageHours(100, 0, start, start + 2 * hour, start), 1);
});

test('observed transitions apply the previous setting until the next observation', () => {
    assert.equal(chlorinatorUsageHours(50, 100, start, start + 36000, start), 0.005);
    assert.equal(chlorinatorUsageHours(0, 100, start, start + 10000, start), 0);
    assert.equal(chlorinatorUsageHours(100, 0, start, start + 36000, start), 0.01);
});

test('even a short gap across a restart averages the persisted and new output', () => {
    assert.equal(chlorinatorUsageHours(20, 80, start, start + 36000, start + 1000), 0.005);
});

test('first observations, invalid values and backwards clocks add no usage', () => {
    assert.equal(chlorinatorUsageHours(undefined, 50, undefined, start, start), 0);
    assert.equal(chlorinatorUsageHours(50, 50, start, start, start), 0);
    assert.equal(chlorinatorUsageHours(50, 50, start, start - 10000, start), 0);
    assert.equal(chlorinatorUsageHours(NaN, 50, start, start + hour, start), 0);
});

test('zero output adds no usage and full output counts all elapsed time', () => {
    assert.equal(chlorinatorUsageHours(0, 0, start, start + hour, start), 0);
    assert.equal(chlorinatorUsageHours(100, 100, start, start + hour, start), 1);
});

test('usage adjustments persist and start a new interval; invalid values leave the total intact', () => {
    // Load the actual state classes in isolation to avoid starting application services.
    const ts = require('typescript');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../controller/State.ts'), 'utf8');
    const ast = ts.createSourceFile('State.ts', source, ts.ScriptTarget.Latest, true);
    const classes = ast.statements.filter(node => ts.isClassDeclaration(node) &&
        ['EqState', 'ChlorinatorState'].includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
    const code = ts.transpileModule(classes, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    let now = start;
    const runtimeState = { dirty: false, _dirtyList: { maybeAddEqState() {} } };
    const context = { exports: {}, state: runtimeState,
        Date: { now: () => now }, chlorinatorUsageHours };
    vm.runInNewContext(code, context);
    const ChlorinatorState = context.exports.ChlorinatorState;
    const cell = new ChlorinatorState({ id: 1, currentOutput: 50,
        usageHours: 1000, usageLastOutput: 50, usageLastSampleAt: start - hour });
    cell.resetUsage();
    assert.equal(cell.usageHours, 0);
    assert.equal(cell.usageLastSampleAt, start);
    assert.equal(cell.usageLastOutput, 50);
    assert.equal(runtimeState.dirty, true);
    assert.equal(cell.hasChanged, true);
    const saved = JSON.parse(JSON.stringify(cell.data));
    const reloaded = new ChlorinatorState(saved);
    now += hour;
    reloaded.currentOutput = 50;
    assert.equal(reloaded.usageHours, 0.5);
    for (const invalid of [-1, NaN, Infinity, '12', null]) {
        assert.throws(() => reloaded.resetUsage(invalid), /non-negative/);
        assert.equal(reloaded.usageHours, 0.5);
        assert.equal(reloaded.usageLastSampleAt, now);
    }
    reloaded.resetUsage(125.5);
    const adjusted = new ChlorinatorState(JSON.parse(JSON.stringify(reloaded.data)));
    assert.equal(adjusted.usageHours, 125.5);
    assert.equal(adjusted.usageLastSampleAt, now);
    now += hour;
    adjusted.currentOutput = 50;
    assert.equal(adjusted.usageHours, 126);
});
