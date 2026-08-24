# Contributing

This repo ships two halves under one `vX.Y.Z` tag: the `version-switcher` plugin
(`plugins/version-switcher.mjs`) and the `assemble` site action (`assemble/`). It is
a JS-only repo — no build step, no framework.

## Developing

```bash
npm test                    # run the test suite (node, no framework)
npm run docs                # build docs (the same command CI uses)
npm run docs-dev            # live-preview docs with the plugin loaded from local plugins/
```

`docs/myst.yml` loads the plugin from the local `plugins/` path (not a release URL),
so edits are reflected on rebuild.

**Browser caveat:** `<select>` popups don't open in the VS Code Simple Browser. Open
the forwarded port in a real browser and hard-reload (MyST caches the localised esm).

## Releasing

Releases are cut by pushing a tag (the UI "publish a release" flow can't attach the
build's assets under immutable releases). Tag the merged commit on `origin/main`
directly — you're usually on a feature branch, so this avoids tagging your branch HEAD:

```bash
git fetch origin
git tag vX.Y.Z origin/main
git push origin --tags
```

(`--tags` pushes every local tag; on a clean clone that's just the new one. Use
`git push origin vX.Y.Z` to push only that tag.)

CI runs lint + tests + the docs build, and `release.yml` creates the GitHub Release with
`version-switcher.mjs` + the tag's `docs.zip` attached (via `gh`). When that CI run
completes, `publish.yml` picks it up on `workflow_run` and reconstructs + deploys the site
including the new tag — the release asset is already attached by then, because
`release.yml` ran inside the run publish is waiting on. The plugin URL and the `uses:`
refs for the reusable workflows all resolve to the same tag, so one tag versions both
halves.
