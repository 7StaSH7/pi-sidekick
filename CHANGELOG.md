# Changelog

Notable changes are recorded here. Releases use [Semantic Versioning](https://semver.org/).

## Unreleased

- Read saved stats and task transcripts without opening, migrating, or rewriting session files; report incomplete history and preserve task reports when transcripts are unavailable.
- Show two-line estimated cost comparisons, duration totals, and branch savings in the footer while Sidekick is on or off.

## [0.2.0] - 2026-09-23

- Rename active UI branding, the public tool, configuration, worker environment, session directory, and state/stat markers to Sidekick.
- Migrate valid `fusion.json` configuration to `sidekick.json` without removing the original; prefer the new file and fail on invalid data.
- Restore legacy state/stat markers and copy old checkpoints into `sidekick/sessions` on demand without rewriting or deleting source sessions.
- Keep historical lead-session tool calls as stored; the former `fusion_sidekick` tool is not registered.

[0.2.0]: https://github.com/7StaSH7/pi-sidekick/releases/tag/v0.2.0

## [0.1.1] - 2026-09-23

- Rename the runtime command from `/fusion` to `/sidekick`; internal Fusion tool, configuration, session, and state names remain unchanged for compatibility.

[0.1.1]: https://github.com/7StaSH7/pi-sidekick/releases/tag/v0.1.1

## [0.1.0] - 2026-09-23

First public release as **pi-sidekick**. Existing `/fusion` commands, `fusion_sidekick` tool, and saved configuration/session names are preserved.

### Features

- Persistent OpenAI sidekick with configurable model, reasoning level, and task timeout.
- Unchanged lead model; pinned sidekick selection with no silent fallback.
- Checkpoint-aware resume, fork, clone, and tree navigation.
- Native progress display, permission forwarding, cancellation, and saved task reports.
- Delegated usage accounting and explicitly qualified cost estimates.

### Reliability

- Removed the old 64-tool-call cap that could interrupt implementation without a final report; task timeouts remain in force.
- Failure diagnostics include the saved session path when available.
- Offline regression coverage for more than 64 calls, tool restrictions, RPC lifecycle, configuration, and accounting.

### Distribution

- MIT license, GitHub installation instructions, Linux CI, and versioned release archives.

[0.1.0]: https://github.com/7StaSH7/pi-sidekick/releases/tag/v0.1.0
