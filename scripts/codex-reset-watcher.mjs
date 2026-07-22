#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR = 60 * 60 * 1000;
const DEFAULT_DROP_THRESHOLD = 15;
const DEFAULT_SCHEDULE_GRACE_HOURS = 2;
const DEFAULT_HISTORY_LIMIT = 24 * 90;

function parseArgs(argv) {
  const options = {
    input: null,
    stateDir: process.env.CODEX_RESET_WATCHER_STATE_DIR
      || path.join(os.homedir(), 'Library', 'Application Support', 'Codex Reset Watcher'),
    notify: !argv.includes('--no-notify'),
    dropThreshold: Number(process.env.CODEX_RESET_DROP_THRESHOLD || DEFAULT_DROP_THRESHOLD),
    scheduleGraceHours: Number(process.env.CODEX_RESET_SCHEDULE_GRACE_HOURS || DEFAULT_SCHEDULE_GRACE_HOURS),
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') options.input = argv[++index];
    if (argv[index] === '--state-dir') options.stateDir = argv[++index];
    if (argv[index] === '--drop-threshold') options.dropThreshold = Number(argv[++index]);
    if (argv[index] === '--schedule-grace-hours') options.scheduleGraceHours = Number(argv[++index]);
  }

  if (!Number.isFinite(options.dropThreshold) || options.dropThreshold <= 0) {
    throw new Error('Drop threshold must be a positive number.');
  }
  if (!Number.isFinite(options.scheduleGraceHours) || options.scheduleGraceHours < 0) {
    throw new Error('Schedule grace must be a non-negative number.');
  }
  return options;
}

function readCodexBarPayload(inputPath = null) {
  if (inputPath) return JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  const codexbar = process.env.CODEXBAR_BIN || 'codexbar';
  const result = spawnSync(codexbar, [
    'usage', '--provider', 'codex', '--format', 'json', '--json-only',
  ], {
    encoding: 'utf8',
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `CodexBar exited with status ${result.status}.`);
  }
  return JSON.parse(result.stdout);
}

export function sanitizeSnapshot(payload, observedAt = new Date().toISOString()) {
  const records = Array.isArray(payload) ? payload : [payload];
  const record = records.find((candidate) => candidate?.provider === 'codex');
  if (!record) throw new Error('CodexBar returned no Codex provider record.');
  if (record.error) throw new Error(record.error.message || 'CodexBar returned a provider error.');

  const usage = record.usage;
  const weekly = usage?.secondary;
  if (!weekly || !Number.isFinite(weekly.usedPercent)) {
    throw new Error('CodexBar did not return the weekly usage window.');
  }

  return {
    observedAt,
    usedPercent: weekly.usedPercent,
    resetsAt: weekly.resetsAt || null,
    availableResetCredits: Number.isFinite(usage.codexResetCredits?.availableCount)
      ? usage.codexResetCredits.availableCount
      : null,
    dataConfidence: usage.dataConfidence || null,
    source: record.source || null,
  };
}

export function classifyChange(previous, current, options = {}) {
  if (!previous) return null;

  const dropThreshold = options.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
  const scheduleGraceMs = (options.scheduleGraceHours ?? DEFAULT_SCHEDULE_GRACE_HOURS) * HOUR;
  const creditDelta = Number.isFinite(previous.availableResetCredits)
    && Number.isFinite(current.availableResetCredits)
    ? current.availableResetCredits - previous.availableResetCredits
    : 0;

  if (creditDelta > 0) {
    return {
      type: 'possible_banked_reset_grant',
      observedAt: current.observedAt,
      creditDelta,
      message: `${creditDelta} new Codex reset credit${creditDelta === 1 ? '' : 's'} detected. Verify whether Tibo announced a milestone.`,
    };
  }

  const usageDrop = previous.usedPercent - current.usedPercent;
  if (usageDrop < dropThreshold) return null;

  const observedMs = Date.parse(current.observedAt);
  const scheduledMs = Date.parse(previous.resetsAt || '');
  const nearScheduledReset = Number.isFinite(observedMs)
    && Number.isFinite(scheduledMs)
    && Math.abs(observedMs - scheduledMs) <= scheduleGraceMs;
  const spentBankedCredit = creditDelta < 0;

  let type = 'possible_global_reset';
  let message = `Weekly Codex usage fell ${usageDrop.toFixed(0)} points outside the scheduled reset window. Verify Tibo's latest post.`;
  if (spentBankedCredit) {
    type = 'banked_reset_used';
    message = `Weekly Codex usage fell ${usageDrop.toFixed(0)} points as a banked reset credit disappeared.`;
  } else if (nearScheduledReset) {
    type = 'scheduled_weekly_reset';
    message = `Weekly Codex usage reset near its scheduled renewal time.`;
  }

  return {
    type,
    observedAt: current.observedAt,
    usageDrop,
    previousUsedPercent: previous.usedPercent,
    currentUsedPercent: current.usedPercent,
    previousResetsAt: previous.resetsAt,
    currentResetsAt: current.resetsAt,
    message,
  };
}

function notify(event) {
  if (!event || !['possible_global_reset', 'possible_banked_reset_grant'].includes(event.type)) return;
  const title = event.type === 'possible_global_reset'
    ? 'Possible global Codex reset'
    : 'Possible milestone reset credit';
  const escapeAppleScript = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  spawnSync('/usr/bin/osascript', [
    '-e',
    `display notification "${escapeAppleScript(event.message)}" with title "${escapeAppleScript(title)}"`,
  ], { encoding: 'utf8', timeout: 10_000 });
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) return { version: 1, last: null, history: [], events: [] };
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return {
    version: 1,
    last: parsed.last || null,
    history: Array.isArray(parsed.history) ? parsed.history : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
  };
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, statePath);
}

export function updateState(state, snapshot, options = {}) {
  const event = classifyChange(state.last, snapshot, options);
  const history = [...state.history, snapshot].slice(-DEFAULT_HISTORY_LIMIT);
  const events = event ? [...state.events, event].slice(-250) : state.events;
  return {
    event,
    state: { version: 1, last: snapshot, history, events },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = readCodexBarPayload(options.input);
  const snapshot = sanitizeSnapshot(payload);
  const statePath = path.join(options.stateDir, 'state.json');
  const previousState = readState(statePath);
  const result = updateState(previousState, snapshot, options);
  writeState(statePath, result.state);
  if (options.notify) notify(result.event);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    snapshot,
    event: result.event,
    statePath,
  }, null, 2)}\n`);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Codex reset watcher: ${error.message}\n`);
    process.exitCode = 1;
  }
}
