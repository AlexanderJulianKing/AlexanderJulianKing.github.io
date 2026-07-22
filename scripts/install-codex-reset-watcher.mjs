#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.alexanderking.codex-reset-watcher';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const watcherPath = path.join(scriptDirectory, 'codex-reset-watcher.mjs');
const agentsDirectory = path.join(os.homedir(), 'Library', 'LaunchAgents');
const logsDirectory = path.join(os.homedir(), 'Library', 'Logs', 'Codex Reset Watcher');
const plistPath = path.join(agentsDirectory, `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function findExecutable(name, fallbacks = []) {
  const located = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  if (located.status === 0 && located.stdout.trim()) return located.stdout.trim();
  const fallback = fallbacks.find((candidate) => fs.existsSync(candidate));
  if (fallback) return fallback;
  throw new Error(`Could not find ${name}.`);
}

function launchctl(args, allowFailure = false) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `launchctl ${args[0]} failed.`);
  }
  return result;
}

function uninstall() {
  launchctl(['bootout', `${domain}/${LABEL}`], true);
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  process.stdout.write(`Removed ${LABEL}. Local watcher history was preserved.\n`);
}

function install() {
  if (!fs.existsSync(watcherPath)) throw new Error(`Watcher not found at ${watcherPath}.`);
  const nodePath = process.execPath;
  const codexbarPath = findExecutable('codexbar', [
    '/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI',
  ]);

  fs.mkdirSync(agentsDirectory, { recursive: true });
  fs.mkdirSync(logsDirectory, { recursive: true });

  const stdoutPath = path.join(logsDirectory, 'watcher.log');
  const stderrPath = path.join(logsDirectory, 'watcher-error.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(watcherPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEXBAR_BIN</key>
    <string>${escapeXml(codexbarPath)}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;

  fs.writeFileSync(plistPath, plist, { mode: 0o600 });
  const lint = spawnSync('/usr/bin/plutil', ['-lint', plistPath], { encoding: 'utf8' });
  if (lint.status !== 0) throw new Error(lint.stderr.trim() || 'Generated LaunchAgent is invalid.');

  launchctl(['bootout', `${domain}/${LABEL}`], true);
  launchctl(['bootstrap', domain, plistPath]);
  launchctl(['kickstart', '-k', `${domain}/${LABEL}`]);

  process.stdout.write(`Installed ${LABEL}.\n`);
  process.stdout.write('Codex usage is checked hourly; only sanitized quota state is stored locally.\n');
  process.stdout.write(`Logs: ${logsDirectory}\n`);
}

try {
  if (process.argv.includes('--uninstall')) uninstall();
  else install();
} catch (error) {
  process.stderr.write(`Watcher installer: ${error.message}\n`);
  process.exitCode = 1;
}
