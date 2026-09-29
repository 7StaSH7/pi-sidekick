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

The extension provides one persistent Sidekick worker per invoking session. Sidekick is optional inside any host-managed agent/workflow session when that session's tools and extensions permit it. Existing systems retain control of topology, scheduling, permissions, isolation, and workspace concurrency. This package does not install, create, configure, or enable other agent systems; used alone, the flow is simply lead → Sidekick.

## Quick start

**Requirements:** Node.js 22.19+, pi 0.87.1 or newer, a project the host reports as trusted when Sidekick runs, and an authenticated provider with a registered model. CI tests pi 0.87.1 on Linux; other versions and platforms are not part of the current test matrix.

1. Install the tagged release:

   ```bash
   pi install git:github.com/7StaSH7/pi-sidekick@v0.4.0
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
| `/sidekick steer <correction>` | Queue a user correction for the active task, after its current tools finish. |
| `/sidekick stats` | Show delegated cost estimates for the current branch. |
| `/sidekick stats all` | Aggregate estimates across saved sessions. |
| `/sidekick reset` | Use fresh sidekick history on the next task; does not undo edits. |

During a task, status, statistics, and steering remain available. A steering correction accepts up to 4000 characters and does not interrupt an already-running tool. Unconsumed corrections are discarded when the task ends; they do not carry into the next task. Notifications omit correction text, but consumed corrections are saved in the task transcript. Press **Esc** to cancel before changing settings or resetting. Cancellation keeps any file changes already made.

In the TUI, setup offers model search by provider, ID, or name, an eight-row list, and input/cache-read/output API rates in USD per million tokens. Missing prices are unavailable; listed zero API rates do not imply free subscription usage. RPC clients keep native selection dialogs.

Setup preselects the current model, marked `(Current)`, and puts current reasoning and timeout values first. Enter keeps each selection; cancelling leaves the existing configuration unchanged. A successful setup restarts the worker on its next task while preserving its checkpoint history.

## How it works

1. The invoking session calls `sidekick` with a self-contained brief, constraints, and observable success criteria—not its entire conversation.
2. The extension launches a native pi RPC child in the same working directory, with the chosen provider, model, and reasoning pinned.
3. The child reads and edits files, runs tools, and forwards supported permission dialogs. Later briefs reuse its session.
4. The invoking session receives the report, usage, and session path, then checks the actual changes and test evidence.

Use Sidekick only when a bounded task benefits from a separate worker; direct work remains an option. Call it alone in the invoking session and avoid overlapping edits to files assigned to it. This local coordination rule does not govern other sessions: existing agent/workflow rules own their topology and workspace concurrency.

### Progress

```text
⠋ Working · 1.2s
openai-codex/gpt-5.6-luna · max · executing actions · completed: 1
▶ read src/dates.ts:40–75 · now
✓ grep parseDate in src · 120ms
```

Completed calls show **Report ready**, not verified task completion. The worker's Markdown report states its result, changed paths, exact verification commands and outcomes, and open items. The lead still reviews the actual diff and check evidence. Expanded shell output and transcripts remain plain text.

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

Expanded cards include the full caveat. Estimates include recorded failed and cancelled Sidekick work, but exclude lead planning/review and other agent-system overhead, including direct Agent usage. `/sidekick stats all` can include Sidekick records from discoverable child-session files and deduplicates them by call ID; in-memory or undiscoverable sessions are absent. These comparisons are not net orchestration cost, expected savings, or a guarantee. Subscription billing, different tokenization, retries, context size, and differing solution quality make this **neither a bill nor a benchmark**. No measured speed, quality, or cost advantage is claimed.

The footer shows the current branch estimate while Sidekick is on or off. `/sidekick stats all` is read-only: it scans saved sessions discoverable in Pi's default session directory and the current configured session directory, adds in-memory current-session records, and deduplicates forked copies. It does not recurse into worker logs; deleted sessions and work without a saved stats record are excluded. Malformed JSONL lines and unreadable files are reported because totals may be incomplete.

## Safety and limitations

- **Not a sandbox.** The worker has ordinary pi process permissions. Its allowlisted tools are `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`; shell access can still reach files and the network.
- **Shared files, separate sessions.** The worker edits the working tree directly. Cancellation, failure, and reset do not roll changes back. Session isolation is not a filesystem sandbox; separate sessions may edit the same files. The existing agent/workflow flow owns concurrent-work safety.
- **Host trust and permissions.** Sidekick checks the project-trust status reported by the host before starting its own worker. It cannot repair trust inheritance in an upstream child-session system or enforce a read-only profile. Supported `confirm`, `select`, and `input` dialogs are forwarded; custom TUI and multiline `editor` dialogs are not supported.
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

Installations pinned to a tag do not advance automatically. To change versions, remove the old package source and install the new tagged source; never leave both copies enabled.

### npm and the Pi package gallery

Install the latest published version with:

```bash
pi install npm:pi-sidekick
```

The package includes the `pi-package` keyword and an explicit extension manifest for discovery in the [Pi package gallery](https://pi.dev/packages). Gallery visibility depends on npm indexing after publication. If switching from a GitHub or local installation, remove the old package source first so only one copy is enabled.

## Inspiration and license

Inspired by the lead/implementation-partner idea in [Cognition's Devin Fusion](https://cognition.com/blog/devin-fusion). Independent project; not affiliated with Cognition or OpenAI. Same-token price estimates here are not equivalent to benchmark comparisons between separate runs.

[MIT](LICENSE) © 2026 Aleksandr Stadnik.
