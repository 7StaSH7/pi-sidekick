# Contributing

## Local setup

Use Node.js 22.19+ and the Pi version pinned in CI:

```bash
npm install --global @earendil-works/pi-coding-agent@0.87.1
git clone https://github.com/7StaSH7/pi-sidekick.git
cd pi-sidekick
npm ci
npm test
npm pack --dry-run
```

Tests use `node:test`, temporary agent directories, and deterministic offline model fixtures. They need the `pi` executable on `PATH`, but no API keys or paid model calls. Linux is the CI baseline. Do not load `test/fixture.ts` into a real session.

Try local changes with `pi -e ./index.ts` from a trusted project. Do not load both the local extension and an installed release in the same session. Real delegation requires your own provider authentication.

## Source map

| File | Responsibility |
| --- | --- |
| `index.ts` | Pi hooks, sidekick lifecycle, checkpoints, commands, and tool execution. |
| `policy.mjs`, `config.mjs` | Model selection, validation, prompts, and saved configuration. |
| `rpc.mjs` | Child process transport, events, cancellation, and shutdown. |
| `activity.mjs`, `presentation.mjs` | Progress state and terminal rendering. |
| `cost.mjs` | Usage records and qualified price estimates. |

`test/` contains unit tests and native offline RPC integration tests. An optional ignored `test/footer.test.mjs` may exist in a developer's checkout for a separately installed theme; it is not part of the distributed project or CI.

## Changes and bug reports

Keep changes focused and include a regression test for behavior changes. Run `npm test` and inspect `npm pack --dry-run` before opening a pull request. Preserve model pinning, cancellation, checkpoint integrity, and the tool allowlist.

For bug reports, include Pi/Node versions, OS, relevant error text, and reproduction steps. Remove credentials and private source code. **Do not attach complete session files by default.** They can contain prompts, source, commands, and tool output.

## Maintainer release checklist

1. Update `package.json`, regenerate `package-lock.json` with `npm install --package-lock-only --ignore-scripts`, and update the changelog and README's pinned installation tag.
2. Run `npm ci`, `npm test`, and `npm pack --dry-run`. Review all staged files for secrets and local-only data, then commit the release preparation.
3. Push `main` and wait for its CI run to pass. Create and push the matching annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. Build the package archive and create the GitHub release with reviewed notes:

   ```bash
   npm pack
   gh release create vX.Y.Z pi-sidekick-X.Y.Z.tgz \
     --verify-tag --title "vX.Y.Z" --notes-file /path/to/release-notes.md
   ```

The GitHub release includes source archives automatically and the package archive explicitly. There is no automatic npm publishing and no release token stored in this repository. Tags are immutable release references; fixes get a new version.
