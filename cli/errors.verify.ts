// Verifies the failure envelope: the shape a supervisor reads.
//
//   npx tsx cli/errors.verify.ts

import assert from 'node:assert/strict';
import { CliError, UsageError, failureEnvelope, failureLines } from './errors.ts';

// --- a described failure carries everything a caller needs ----------------

const described = new CliError('render failed', {
  code: 'out-not-absolute',
  step: 'render',
  cause: 'a relative path breaks the AAC encoder-delay probe',
  hint: 'pass an absolute path',
});
const envelope = failureEnvelope(described);
assert.equal(envelope.ok, false, 'failures are never ok');
assert.equal(envelope.error.code, 'out-not-absolute', 'the code is the stable identifier');
assert.equal(envelope.error.step, 'render', 'the stage is named');
assert.equal(envelope.error.cause, 'a relative path breaks the AAC encoder-delay probe', 'the cause is not the message');
assert.equal(envelope.error.hint, 'pass an absolute path', 'the next step is named');

// --- codes are never sentences -------------------------------------------

// A caller branches on the code, so it must not be prose that drifts.
assert.match(envelope.error.code, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'codes are kebab-case');

// --- an undescribed failure still gets a usable code ----------------------

assert.equal(failureEnvelope(new CliError('something broke')).error.code, 'cli-error',
  'a bare CliError falls back to cli-error');
assert.equal(failureEnvelope(new UsageError('bad flag')).error.code, 'usage',
  'a usage error is distinguishable without being described');

// --- the stage falls back to the command the caller asked for -------------

const noStep = failureEnvelope(new CliError('nope', { code: 'x' }), 'qc');
assert.equal(noStep.error.step, 'qc', 'the caller supplies the stage when the error does not');
const ownStep = failureEnvelope(new CliError('nope', { code: 'x', step: 'render' }), 'qc');
assert.equal(ownStep.error.step, 'render', 'the error wins over the caller');

// --- an unexpected throw is labelled as such ------------------------------

const unexpected = failureEnvelope(new TypeError('x is not a function'));
assert.equal(unexpected.error.code, 'unexpected', 'a crash is not dressed up as a known failure');
assert.ok(unexpected.error.hint, 'and it says what to do about it');

// --- the human form adds cause and hint only when they exist -------------

const lines = failureLines(described);
assert.equal(lines.length, 3, 'message, cause, hint');
assert.ok(lines[1]!.includes('cause:'), 'cause is labelled');
assert.ok(lines[2]!.includes('hint:'), 'hint is labelled');

assert.deepEqual(failureLines(new CliError('just this')), ['just this'], 'no padding when there is nothing to add');

console.log('errors.verify: envelope, fallback codes, stage precedence and human lines OK');
