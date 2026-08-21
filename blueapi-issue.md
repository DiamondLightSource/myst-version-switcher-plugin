# Docs site: slow CI, permanently one release behind, and heading for a hard wall

Three separate problems in blueapi's Pages setup, with one shared root cause. Two are
fixed upstream in
[myst-version-switcher-plugin](https://github.com/DiamondLightSource/myst-version-switcher-plugin)
and need a pin bump plus one config line here; one is still open.

Measured on blueapi's own runs, 2026-08-21.

---

## 1. The publish job was slow, which is why it got switched off

[PR #1614](https://github.com/DiamondLightSource/blueapi/pull/1614) narrowed `publish`
to tags only, one day after adoption, because it was adding many minutes to every PR.
That was the right call on the evidence. The evidence:

| step, PR run [31081562099](https://github.com/DiamondLightSource/blueapi/actions/runs/31081562099) | time |
|---|---|
| `Gather release artifacts` — 188 releases listed, 131 `docs.zip` downloaded **one at a time** | 114 s |
| `Gather branch CI artifacts` — 26 open PRs, one **full artifacts-API pagination each** | 175 s |
| `Upload Pages artifact` — 452,549,958 bytes | 36 s |
| `Deploy to GitHub Pages` | 280 s |
| **deploy job total** | **654 s** |

The docs *build* is 27–45 s. Everything else in CI finishes by ~200 s. Publish alone took
the run from ~200 s to ~750 s.

The cause is that the deploy's cost is **O(whole site)**, not O(what changed): every
event re-downloaded ~453 MB of immutable release assets and re-uploaded a 452 MB
artifact, doing identical work regardless of which PR triggered it.

**Fixed upstream.** Release assets are cached (`actions/cache`, keyed on the exact set of
asset ids, so a new release downloads exactly one zip); the artifacts API is paginated
once and indexed by head SHA instead of once per open PR; downloads run in parallel. The
deploy should land near ~100 s, which starts after `docs` (~50 s) and finishes inside
your 195 s `system-test` — off the critical path in wall-clock terms.

## 2. The site is permanently one release behind — **still open**

`https://diamondlightsource.github.io/blueapi/` is missing 1.18.1 right now: the switcher
lists 1.18.0 as `stable` and `/1.18.1/` 404s. This is not a one-off — **every** release
has been missing itself, appearing only when the *next* release is cut.

### Root cause 2a — the tag re-dispatch races the `docs.zip` upload

`publish.yml`'s `re-dispatch` job waits for the release **record**, but the deploy's
gather selects releases by their **`docs.zip` asset**. blueapi publishes releases from
the **GitHub UI**, so the record exists *before* the tag push even starts CI — the wait
is a no-op. Timeline for 1.18.1:

| time (UTC) | event |
|---|---|
| 09:34:14 | release 1.18.1 published (UI) |
| 09:34:16 | tag CI run [32122292712](https://github.com/DiamondLightSource/blueapi/actions/runs/32122292712) starts |
| 09:34:50 | `re-dispatch` sees the release, dispatches immediately |
| 09:35:02 | dispatched deploy [32122349268](https://github.com/DiamondLightSource/blueapi/actions/runs/32122349268) lists releases — **1.18.1 has no assets yet** |
| 09:35:57 | `release / release` attaches `docs.zip` — 55 s too late |

That run logged `Sorted versions: ["main","1.18.0",…]` and `Stable alias source: 1.18.0`.
1.18.0 missed itself the same way and only landed 11 days later, carried in by 1.18.1's
deploy.

**Status: not yet fixed.** The obvious fix (wait for the asset, not the record) is
written and working, but it is on hold behind a larger question — whether publishing
should move off the inline CI path onto a `workflow_run` trigger, which would make this
race disappear entirely (`workflow_run` fires after the tag's CI run, `release.yml`
included, so the asset is already attached). That is being settled by a live experiment
upstream. Either way blueapi gets a fix; this note is so nobody re-debugs it meanwhile.

### Root cause 2b — nothing ever self-heals

```yaml
  publish:
    if: github.repository == 'DiamondLightSource/blueapi' && github.ref_type == 'tag'
```

Every PR and every push to `main` logs `publish → skipped`, so the *only* deploys are tag
re-dispatches — the exact path broken by 2a. A deploy that misses a source stays missed
until the next tag.

**Suggested change**, keeping #1614's intent (no deploy on every PR push) while restoring
self-heal on every merge:

```yaml
  publish:
    needs: [docs]
    # don't publish a pages site in the fork's org
    if: >-
      github.repository == 'DiamondLightSource/blueapi' &&
      (github.ref_type == 'tag' || github.ref == 'refs/heads/main')
```

PR previews still work: **any** deploy gathers every open PR's build artifact, so PR docs
still appear at `/pr-<n>/`, just refreshed on the next `main` deploy rather than on every
push. With problem 1 fixed you may not need to narrow it at all.

## 3. The site is at 45% of a hard limit nobody warns you about

`upload-pages-artifact` tars the **whole** site into one artifact, and GitHub Pages
rejects that artifact over **1 GB**. blueapi's last deploy uploaded **452,549,958 bytes**
across 139 versions, growing ~5 MB per release. That is roughly 110 more releases —
a couple of years — until deploys simply start failing, with no signal on the way.

**Fixed upstream** by a new `max-releases` input. It defaults to `0` (unlimited) so
upgrading changes nothing on its own, and any deploy past 700 MB now warns.

To opt in, set it in `.github/workflows/publish-dispatch.yml`, in the `with:` block —
**not** as an input threaded from `ci.yml`, so it applies on every path (inline publish,
tag re-dispatch, fork preview, manual re-deploy):

```yaml
jobs:
  publish:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/publish.yml@<new-tag>
    with:
      version-name: ${{ inputs.version-name }}
      max-releases: "20"          # ← add this
      pr: ${{ inputs.pr }}
      dispatch-workflow: publish-dispatch.yml
      retry-until: ${{ inputs.retry-until }}
```

For blueapi that takes the released half from **453 MB to 73 MB**. Releases are ranked by
the tagged commit's date, and nothing is deleted — every release keeps its `docs.zip`
asset, so raising the cap brings the old versions straight back on the next deploy.

Worth knowing when picking N: prereleases occupy slots. Your newest 20 releases include
`1.11.5-a1/a2/a3`, `1.11.1-a3` and `1.14.1-dev.1`, so `max-releases: 20` publishes 15
real versions.

---

## Actions for blueapi

1. **Bump the pins** to the new tag once it is cut — currently `@v0.24` in three places:
   `docs.yml` and `release.yml` in `ci.yml`, and `publish.yml` in `publish-dispatch.yml`.
2. **Restore self-heal**: the `ci.yml` `if:` change in 2b.
3. **Set `max-releases`** in `publish-dispatch.yml` (suggest `"20"`).
4. **Backfill 1.18.1 now** — its asset exists, so a manual re-deploy picks it up:
   ```bash
   gh workflow run publish-dispatch.yml --repo DiamondLightSource/blueapi
   ```
5. **Optional cleanup**: six PRs (#1246, #1504, #1512, #1552, #1553, #1561) have `docs`
   artifacts predating the `docs.zip` packing contract, so they log
   `artifact unavailable — skipping`. Harmless; re-running CI on those PRs clears it. The
   upstream warning is now specific about this case rather than a catch-all.
