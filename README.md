# pi-sidekick

**Keep your lead model. Give it a persistent implementation partner.**

[![CI](https://github.com/7StaSH7/pi-sidekick/actions/workflows/ci.yml/badge.svg)](https://github.com/7StaSH7/pi-sidekick/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/7StaSH7/pi-sidekick)](https://github.com/7StaSH7/pi-sidekick/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A [pi](https://github.com/earendil-works/pi) extension that lets your current model plan and review while a configurable sidekick model implements bounded tasks in a separate, persistent session. Inspired by [Cognition's Devin Fusion](https://cognition.com/blog/devin-fusion).

```text
You ↔ Lead model
          │  brief + constraints + success criteria
          ▼
      Sidekick ── read / edit / run checks
          │  report + usage + saved session
          ▼
      Lead verifies the diff and results
```

> **Naming:** the package, `/sidekick` command, public `sidekick` tool, configuration, and new session storage all use the Sidekick name. Version 0.2.0 migrates existing Fusion data without deleting or rewriting the originals; see [Upgrade compatibility](#upgrade-compatibility).

## Why use it?

- **Keep your lead.** Delegation never changes the lead model or reasoning level.
- **Continue, don't restart.** The sidekick retains context between briefs, with checkpoints that follow lead-session branching.
- **Choose the worker.** Select an authenticated model from any provider registered in pi, including custom providers, plus its supported reasoning level and timeout. No silent model fallback.
- **See the work.** Live tool activity, permission prompts, returned reports, and saved sessions stay accessible.
- **Inspect the cost.** Delegated usage and transparent estimates—not claims of measured savings or equal quality.

This is one persistent worker, not a multi-agent swarm. The lead decides when delegation helps and remains responsible for reviewing the result.

## Quick start

**Requirements:** Node.js 22.19+, pi 0.87.1 or newer, a trusted project, and an authenticated provider with a registered model. CI tests pi 0.87.1 on Linux; other versions and platforms are not part of the current test matrix.

1. Install the tagged release:

   ```bash
   pi install git:github.com/7StaSH7/pi-sidekick@v0.2.0
   ```

2. In pi, reload extensions:

   ```text
   /reload
   ```

3. If you have not authenticated a sidekick provider, use `/login` and choose a provider available in your pi setup. Then configure the worker:

   ```text
   /sidekick setup
   ```

4. Give the lead a bounded task, for example:

   ```text
   Use the sidekick to fix the date parser in src/dates.ts and add a focused
   regression test. Keep the public API unchanged. Review its diff and test
   results before reporting completion.
   ```

New sessions enable delegation automatically when the configured model is available. `/sidekick off` persists for that lead session. The default is `openai-codex/gpt-5.6-luna` with `max` reasoning; **that model need not be available in your account**. Use `/sidekick setup` to select a model you actually have. An unavailable default blocks ordinary input until you run setup, enable a valid configuration, or turn Sidekick off.

Already using a local checkout? Keep only one installation enabled; do not load the local and GitHub copies together. Local development still supports `pi install .`.

## Commands

| Command | What it does |
| --- | --- |
| `/sidekick setup` | Choose the sidekick model, supported reasoning, and timeout. |
| `/sidekick on` | Validate the selection and enable delegation. |
| `/sidekick off` | Stop the idle worker and disable delegation. |
| `/sidekick status` | Show the selection, timeout, and saved session path. |
| `/sidekick stats` | Show delegated cost estimates for the current branch. |
| `/sidekick stats all` | Aggregate estimates across saved sessions. |
| `/sidekick reset` | Use fresh sidekick history on the next task; does not undo edits. |

During a task, status and statistics remain available. Press **Esc** to cancel before changing settings or resetting. Cancellation keeps any file changes already made.

Setup puts each current value first, marked `(Current)`. Enter keeps it; cancelling leaves the existing configuration unchanged. A successful setup restarts the worker on its next task while preserving its checkpoint history.

## How it works

1. The lead calls `sidekick` with a self-contained brief, constraints, and observable success criteria—not the entire lead conversation.
2. The extension launches a native pi RPC child in the same working directory, with the chosen provider, model, and reasoning pinned.
3. The child reads and edits files, runs tools, and forwards supported permission dialogs. Later briefs reuse its session.
4. The lead receives the report, usage, and session path, then checks the actual changes and test evidence.

The lead instructions discourage concurrent lead tools while delegation is running. A tool-call guard blocks sibling lead tools in the same batch. Nested delegation by the worker is blocked.

### Progress

```text
⠋ Working · 1.2s
openai-codex/gpt-5.6-luna · max · executing actions · completed: 1
▶ read src/dates.ts:40–75 · now
✓ grep parseDate in src · 120ms
```

The theme-aware display shows monotonic elapsed time, counts completed actions, keeps five recent actions collapsed, and shows retry/compaction phases. Expand a live result with the tool-output keybinding (default **Ctrl+O**) to see its full safe action timeline. Expand a completed result to load only that task's saved transcript: brief, assistant text, tool calls and arguments, results, final report, and any compaction summary. System prompts and hidden thinking are excluded; binary image payloads are marked as omitted by the text renderer. Transcript expansion reads existing JSONL files in the Sidekick or legacy Fusion session roots only; it does not open, migrate, or rewrite them, and rejects outside paths and escaped symlinks. If history is missing or corrupt, the renderer shows the reason and keeps the original report or error visible. The expanded transcript can contain private source, commands, and tool output; it is not a secret-redaction boundary. Compact progress still bounds displayed arguments and hides suspicious shell commands.

### Configuration and sessions

Configuration lives at `~/.pi/agent/sidekick.json` (or inside `PI_CODING_AGENT_DIR`):

```json
{
  "sidekick": {
    "provider": "openai-codex",
    "id": "gpt-5.6-luna",
    "thinking": "max"
  },
  "timeoutMinutes": 60
}
```

Prefer `/sidekick setup` to editing JSON. The timeout accepts integers from **1 to 1440 minutes**; setup offers 15, 30, 60, 120, 240, and any currently configured value. Missing timeout values default to 60. The old boolean `animation` field is accepted for migration, ignored, and omitted on the next save.

Private session files live under `~/.pi/agent/sidekick/sessions/`. Resume preserves worker history; lead forks, clones, and tree navigation use checkpoint-aware branching rather than inheriting abandoned work. Session files may contain source code, commands, and tool results: do not publish them.

### Upgrade compatibility

On first load, if `sidekick.json` is absent, the extension validates `fusion.json` and atomically saves the same settings to `sidekick.json`. The old file is never changed or deleted. An existing `sidekick.json` takes precedence; if it is invalid, startup fails instead of falling back to old settings.

Saved lead sessions keep their history. The extension reads both generations of state/stat records. When a legacy checkpoint is resumed, its `.jsonl` is validated inside `~/.pi/agent/fusion/sessions/` and copied to `~/.pi/agent/sidekick/sessions/` under the same basename only if no destination exists. The original log is not rewritten or removed; later restores never overwrite the migrated copy.

After installing 0.2.0, run `/reload` before resuming an old lead session. Historical tool-call entries may still show `fusion_sidekick`; they are not rewritten, and no old tool alias is registered.

### Cost estimates, not savings claims

`/sidekick stats` compares sidekick usage with the estimated price of **the same token quantities** at the lead model's captured rates. Reported API costs are used when complete and usable; otherwise sidekick cost is estimated from captured rates. Missing or unusable prices are shown as unavailable, not free. Compact result cards use two lines:

```text
Sidekick $0.02 · Lead equivalent $2.11
≈ Saved $2.09 (99.1%) · API-rate estimate
```

Expanded cards include the full caveat. Estimates include recorded failed and cancelled work, but exclude lead planning and review. Subscription billing, different tokenization, retries, context size, and differing solution quality make this **neither a bill nor a benchmark**. No measured speed, quality, or cost advantage is claimed.

The footer shows the current branch estimate while Sidekick is on or off. `/sidekick stats all` is read-only: it scans saved lead sessions discoverable in Pi's default session directory and the current configured session directory, adds in-memory current-session records, and deduplicates forked copies. It does not recurse into worker logs; deleted sessions and work without a saved stats record are excluded. Malformed JSONL lines and unreadable files are reported because totals may be incomplete.

## Safety and limitations

- **Not a sandbox.** The worker has ordinary pi process permissions. Its allowlisted tools are `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`; shell access can still reach files and the network.
- **Shared files, separate conversation.** The worker edits the working tree directly. Cancellation, failure, and reset do not roll changes back. Review your diff before retrying a partially completed task.
- **Native permissions.** Project trust and explicit CLI extensions are inherited. Supported `confirm`, `select`, and `input` dialogs are forwarded; custom TUI and multiline `editor` dialogs are not supported.
- **Bounded execution.** The configured timeout limits a task. There is no arbitrary tool-call count cap. Reports are truncated at 2,000 lines or 50 KB; saved sessions retain the underlying history.
- **No credential forwarding magic.** One-off CLI API keys and in-memory extension state are not forwarded. Configure provider authentication through pi. No model/provider fallback is allowed.

No extra runtime dependencies are bundled. The extension uses the Pi-provided coding-agent, AI, TUI, and TypeBox packages.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Startup error or ordinary input blocked | Run `/login` if needed, then `/sidekick setup`; `/sidekick off` restores lead-only operation. |
| `/sidekick` is missing after installation | Try `/reload`; if still missing, restart pi with `pi --resume`. |
| Timeout, cancellation, or `toolUse` failure | Inspect the error's saved session and working-tree diff before continuing. A blocked tool can intentionally end the worker. |
| Old “tool budget exhausted (64)” error | Reload the extension; this release removes that cap. An already-running worker can still hold the old code. |
| Need to discard worker conversation | Cancel any active task, then `/sidekick reset`. This does not revert files. |

The extension does not blindly replay failed briefs: a failed task may already have performed edits. Native pi/provider retry behavior remains pi's responsibility.

## Development and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, architecture, and the release checklist. See [CHANGELOG.md](CHANGELOG.md) and [GitHub Releases](https://github.com/7StaSH7/pi-sidekick/releases) for version history.

Installations pinned to a tag do not advance automatically. To change versions, remove the old package source and install the new tagged source; never leave both copies enabled. This project is distributed through GitHub; no npm registry installation is advertised.

## Inspiration and license

Inspired by the lead/implementation-partner idea in [Cognition's Devin Fusion](https://cognition.com/blog/devin-fusion). Independent project; not affiliated with Cognition or OpenAI. Same-token price estimates here are not equivalent to benchmark comparisons between separate runs.

[MIT](LICENSE) © 2026 Aleksandr Stadnik.
