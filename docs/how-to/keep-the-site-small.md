# How-to: keep the published site under the Pages size limit

Every deploy uploads the **whole** site as one artifact, and GitHub Pages rejects an
artifact over **1 GB**. The cap is on the **compressed** upload, not the directory tree —
HTML and JS pack around 3×, so a site that is 734 MiB on disk deploys as about 223 MiB.

A docs build is a few megabytes, so this only bites long-lived projects — but it bites
them hard. [blueapi](https://github.com/DiamondLightSource/blueapi), with 131 released
`docs.zip`s, was at **452 MB** and adding ~5 MB per release.

## What happens when you hit it

`actions/deploy-pages` compares the uploaded artifact against the limit and warns:

```
Uploaded artifact size of 1103175680 bytes exceeds the allowed size of 1 GB. Deployment might fail.
```

That warning only appears once you are already over, so treat a deploy that emits it as
needing action now. Nothing is lost when it happens: cap the site with the two inputs
below and re-run the deploy — every release still has its `docs.zip` asset, so raising
the cap again brings the old versions straight back.

## Check where you are

Every deploy prints the size of the tree it assembled (on disk, so roughly 3× what will
actually be uploaded):

```
assembled site: 734M on disk across 31 version dir(s)
```

Or measure the released half directly:

```bash
gh api --paginate repos/ORG/REPO/releases \
  | jq -rs '[.[][].assets[] | select(.name=="docs.zip") | .size] | add / 1048576 | floor'
```

## Cap what gets published

Two inputs, both set in your `publish.yml`'s `with:` block:

```yaml
jobs:
  publish:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/publish-gh-pages.yml@<tag>
    with:
      pr: ${{ inputs.pr }}
      max-releases: "30"        # ← publish only the 30 most recent releases
      max-prs: "20"             # ← and previews for only the 20 most recently built PRs
```

:::{important}
**Literals**, not inputs threaded in from elsewhere. `publish.yml` is the single caller
of the engine on every path — the `workflow_run` deploy, a fork preview, a manual
re-deploy — so a literal here is the one place the policy cannot be bypassed.
:::

Both default to `0`, meaning unlimited, so upgrading the pinned tag never removes
versions from a site that already has them. You opt in.

### How the two caps rank

- **`max-releases`** ranks by the **tagged commit's date** (`created_at`), newest first.
  Nothing parses your version numbers — tags vary far too much between projects for that
  to be safe, and `published_at` is unreliable because re-publishing an old release
  stamps it as new.
- **`max-prs`** ranks by when each PR's docs were last **built**, newest first, so an
  abandoned PR's preview drops off before an active one's.

Both cap only what is *eligible*: a release with no `docs.zip` asset, a PR whose build
artifact has expired, and an unapproved fork PR never consume a slot.

Capping only affects **what the site serves** — nothing is deleted. Dropped versions
leave the switcher and their URLs 404, so pick N so the versions people actually link to
stay in. Note that prereleases occupy slots too: blueapi's newest 20 releases include 5
prereleases, so `max-releases: 20` would publish only 15 real ones.

### It also bounds the Actions cache

The engine caches release zips so a deploy re-downloads only what changed. That cache
entry is as big as the published release set, and each new release writes a *fresh*
entry, all of it counting against the repo's **10 GB** Actions cache quota — which is
shared with your build caches, and evicted by LRU when full. At blueapi's 458 MB of
release zips, an uncapped cache entry would push their other caches out within a few
releases. `max-releases: 30` keeps it near 100 MB.

## What isn't capped

- **The default branch** — always published; it is the one required version.
- **The migration seed release** (`pages-default-seed`) — it stands in for the default
  branch rather than being a version of its own.

## Related

- [choose-publish-events](choose-publish-events.md) — how often deploys run
- [architecture](../explanations/architecture.md#why-the-site-has-a-size-limit) — why
  reconstruct-everything has this cost at all
