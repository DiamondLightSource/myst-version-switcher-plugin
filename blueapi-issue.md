## Docs site is permanently one release behind

`https://diamondlightsource.github.io/blueapi/` is missing 1.18.1 — the switcher
still lists 1.18.0 as `stable`, and https://diamondlightsource.github.io/blueapi/1.18.1/
404s. This isn't a one-off: **every** release has been missing itself, and only
appears on the site when the *next* release is cut.

### Root cause 1 — the tag re-dispatch races the `docs.zip` upload

`publish.yml`'s `re-dispatch` job waits for the **release record** to exist
(`gh release view --json publishedAt`) before firing the deploy. But the deploy's
gather step selects releases by their **`docs.zip` asset**.

blueapi publishes releases from the **GitHub UI**, so the release record exists
*before* the tag push even triggers CI — the wait is a no-op, and the deploy runs
while `release.yml` is still building. Timeline for 1.18.1:

| time (UTC) | event |
|---|---|
| 09:34:14 | release 1.18.1 published (UI) |
| 09:34:16 | tag CI run [32122292712](https://github.com/DiamondLightSource/blueapi/actions/runs/32122292712) starts |
| 09:34:50–54 | `publish / re-dispatch` sees the release, dispatches immediately |
| 09:35:02 | dispatched deploy [32122349268](https://github.com/DiamondLightSource/blueapi/actions/runs/32122349268) lists releases — **1.18.1 has no assets yet** |
| 09:35:57 | `release / release` attaches `docs.zip` — 55 s too late |

That run's log confirms it: `Sorted versions: ["main","1.18.0","1.17.0",…]`,
`Stable alias source: 1.18.0`.

Same for 1.18.0: [run 31167339050](https://github.com/DiamondLightSource/blueapi/actions/runs/31167339050)
logged `Sorted versions: ["main","1.17.0",…]` — it missed itself too, and only landed
on the site 11 days later when 1.18.1's deploy ran. 1.17.0 and 1.16.0 show the same
~2.5 min asset lag.

**Fix:** in myst-version-switcher-plugin. The `re-dispatch` job will poll for the
tag's **`docs.zip` asset** rather than the release record. Nothing to change here
beyond bumping the pin (below).

### Root cause 2 — the site never self-heals, because publish only runs on tags

`.github/workflows/ci.yml`:

```yaml
  publish:
    needs: [docs]
    if: github.repository == 'DiamondLightSource/blueapi' && github.ref_type == 'tag'
```

Added in #1614. Every PR and every push to `main` logs `publish → skipped`, so the
*only* deploys are tag re-dispatches — the exact path broken by root cause 1. A
deploy that misses a source stays missed until the next tag.

**Suggested change** — keeps #1614's intent (no Pages deploy on every PR push) while
restoring self-heal on every merge:

```yaml
  publish:
    needs: [docs]
    # don't publish a pages site in the fork's org
    if: >-
      github.repository == 'DiamondLightSource/blueapi' &&
      (github.ref_type == 'tag' || github.ref == 'refs/heads/main')
```

Note PR previews still work with this: **any** deploy gathers every open PR's build
artifact, so PR docs still appear at `/pr-<n>/` — just refreshed on the next `main`
deploy instead of on every PR push.

### Also worth doing

**Bump the pins** once the upstream fix is tagged (currently `@v0.24` in three
places): `docs.yml` and `release.yml` in `ci.yml`, and `publish.yml` in
`.github/workflows/publish-dispatch.yml`.

**Backfill 1.18.1 now** — the asset exists, so a manual re-deploy picks it up:

```bash
gh workflow run publish-dispatch.yml --repo DiamondLightSource/blueapi
```

**Six stale PR artifacts** warn `artifact unavailable — skipping` (#1246, #1504,
#1512, #1552, #1553, #1561). Their `docs` artifacts predate the `docs.zip` packing
contract (e.g. #1561's is from 2026-07-02), so they contain no `docs.zip`. Harmless
— re-running CI on those PRs clears it. The upstream warning message will be made
specific about this case.
