import assert from 'node:assert/strict';

import {
  classifyChange,
  sanitizeSnapshot,
  updateState,
} from '../scripts/codex-reset-watcher.mjs';

function payload({ used = 49, resetsAt = '2026-07-28T17:03:09Z', credits = 0 } = {}) {
  return [{
    provider: 'codex',
    source: 'oauth',
    usage: {
      secondary: { usedPercent: used, resetsAt, windowMinutes: 10080 },
      codexResetCredits: { availableCount: credits },
      dataConfidence: 'exact',
      accountEmail: 'must-not-survive@example.com',
    },
  }];
}

const sanitized = sanitizeSnapshot(payload(), '2026-07-22T23:30:00Z');
assert.deepEqual(sanitized, {
  observedAt: '2026-07-22T23:30:00Z',
  usedPercent: 49,
  resetsAt: '2026-07-28T17:03:09Z',
  availableResetCredits: 0,
  dataConfidence: 'exact',
  source: 'oauth',
});
assert.equal(JSON.stringify(sanitized).includes('must-not-survive'), false);

const previous = sanitized;
const globalReset = classifyChange(previous, {
  ...previous,
  observedAt: '2026-07-23T00:30:00Z',
  usedPercent: 0,
  resetsAt: '2026-07-30T00:30:00Z',
});
assert.equal(globalReset.type, 'possible_global_reset');

const scheduledReset = classifyChange(previous, {
  ...previous,
  observedAt: '2026-07-28T17:30:00Z',
  usedPercent: 0,
  resetsAt: '2026-08-04T17:30:00Z',
});
assert.equal(scheduledReset.type, 'scheduled_weekly_reset');

const bankedReset = classifyChange({ ...previous, availableResetCredits: 1 }, {
  ...previous,
  observedAt: '2026-07-23T00:30:00Z',
  usedPercent: 0,
  availableResetCredits: 0,
});
assert.equal(bankedReset.type, 'banked_reset_used');

const creditGrant = classifyChange(previous, {
  ...previous,
  observedAt: '2026-07-23T00:30:00Z',
  availableResetCredits: 1,
});
assert.equal(creditGrant.type, 'possible_banked_reset_grant');

assert.equal(classifyChange(previous, { ...previous, usedPercent: 55 }), null);

const initial = updateState({ version: 1, last: null, history: [], events: [] }, sanitized);
assert.equal(initial.event, null);
assert.equal(initial.state.history.length, 1);
assert.deepEqual(initial.state.last, sanitized);

console.log('Codex reset watcher checks passed.');
