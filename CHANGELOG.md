# Changelog

Notable changes are recorded here. Releases use [Semantic Versioning](https://semver.org/).

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
