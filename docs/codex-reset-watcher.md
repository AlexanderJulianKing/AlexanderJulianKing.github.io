# Codex reset watcher

The watcher takes an hourly, private snapshot of the Codex weekly quota reported by CodexBar. It is a corroborating signal for milestone resets, not a public data source and not proof that a milestone occurred.

## What it stores

Only these fields are retained in `~/Library/Application Support/Codex Reset Watcher/state.json`:

- observation time
- weekly percentage used
- scheduled weekly reset time
- number of available banked reset credits
- CodexBar source and confidence labels

Account names, email addresses, authentication material, five-hour usage, prompts, and session content are discarded before anything is written. The state file remains outside the website repository and is created with owner-only permissions.

## Detection rules

- A weekly-usage decrease of at least 15 percentage points outside a two-hour window around the scheduled renewal is flagged as a **possible global reset**.
- The same decrease near the scheduled renewal is recorded as a normal weekly reset.
- A decrease accompanied by one banked credit disappearing is recorded as use of a banked reset.
- An increase in available reset credits is flagged as a possible banked-reset grant.

Possible milestone signals create a local macOS notification. They never edit or deploy the website automatically. Tibo's post still determines the milestone number and whether the action was an immediate global reset, a banked reset, or no reset.

## Commands

Run the tests:

```bash
node docs/codex-reset-watcher-test.mjs
```

Take a one-off snapshot:

```bash
node scripts/codex-reset-watcher.mjs --no-notify
```

Install or refresh the hourly LaunchAgent:

```bash
node scripts/install-codex-reset-watcher.mjs
```

Remove the LaunchAgent while preserving its local history:

```bash
node scripts/install-codex-reset-watcher.mjs --uninstall
```

## Confirmation protocol

When the watcher raises a possible reset:

1. Open Tibo's latest post and record its canonical URL and timestamp.
2. Classify the event as `immediate`, `banked`, `none`, or `unknown`.
3. Do not move the weekly-renewal baseline unless the post or observed quota change confirms an immediate global reset.
4. Archive the resolved forecast before changing its target, then add the new milestone and recompute the next forecast.
5. Run the predictor and watcher regression tests before publishing.
