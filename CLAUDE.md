# Gitline: notes for Claude

## Releases: only when the owner says they're ready

Never start a release build or publish anything unless the owner has explicitly said they're ready
for that specific release ("I'm ready", "build it", "release it" for this version). Finishing a feature,
passing tests or being asked to "push" is not permission to release.

Until then, do not:

- push a `v*` tag (that starts `.github/workflows/release.yml`, which builds installers);
- run `npm version` (it creates a tag), or `npm run dist` / `electron-builder --publish`;
- run the Release workflow by hand (`gh workflow run release.yml`);
- create, edit, publish or un-draft a GitHub release.

Committing and pushing `main` is fine when asked; that only runs CI tests.

When the owner says to release: tag the current `main` with the version in `package.json`
(bump it first only if that version is already released), push the tag, wait for the Release workflow,
check the single draft has every installer, add release notes, and publish only if they asked for that too.

## Checks before handing work back

- `npm run typecheck`, `npm test` (unit + git integration) and `npm run test:e2e` (builds, then drives the app).
- End-to-end tests run at the minimum window size (960×640); layout changes must work there.
