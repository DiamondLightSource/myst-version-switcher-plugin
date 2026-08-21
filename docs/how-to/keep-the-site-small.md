# How-to: keep the published site under the Pages size limit

Every deploy uploads the **whole** site as one artifact, and GitHub Pages rejects an
artifact over **1 GB**. Nothing warns you as you approach it; deploys simply start
failing once you arrive.

The cap is on the **packed** artifact, not the directory tree — HTML and JS compress
around 3×, so a site that is 734 MiB on disk deploys as about 223 MiB.

A docs build is a few megabytes, so this only bites long-lived projects — but it bites
them hard. [blueapi](https://github.com/DiamondLightSource/blueapi), with 131 released
`docs.zip`s, was at **452 MB** and adding ~5 MB per release: a few years of headroom, and
no signal on the way.

## Check where you are

Every deploy prints the size of the tree it assembled:

```
assembled site: 734MB uncompressed across 31 version dir(s)
```

Once that passes 1.5 GiB it also packs the tree to measure what will really be
uploaded, and warns past 700 MB of *packed* bytes:

```
packed artifact: ~712MB (Pages rejects over 1 GB)
```

Or measure the released half directly:

```bash
gh api --paginate repos/ORG/REPO/releases \
  | jq -rs '[.[][].assets[] | select(.name=="docs.zip") | .size] | add / 1048576 | floor'
```

## Cap the number of published releases

Set `max-releases` in your `publish.yml`, in the `with:` block:

```yaml
jobs:
  publish:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/publish-gh-pages.yml@<tag>
    with:
      max-releases: "20"        # ← publish only the 20 most recent releases
      pr: ${{ inputs.pr }}
```

:::{important}
A **literal**, not an input threaded in from elsewhere. `publish.yml` is the single caller
of the engine on every path — the `workflow_run` deploy, a fork preview, a manual
re-deploy — so a literal here is the one place the policy cannot be bypassed.
:::

The default is `0`, meaning unlimited, so upgrading the pinned tag never removes versions
from a site that already has them. You opt in.

### What the cap does and doesn't do

Releases are ranked by the **tagged commit's date** (`created_at`), newest first, and the
top N are published. Nothing parses your version numbers — tags vary far too much between
projects for that to be safe, and `published_at` is unreliable because re-publishing an
old release stamps it as new.

Capping only affects **what the site serves**. Every release keeps its `docs.zip` asset on
the GitHub Release, so raising the cap brings the old versions straight back on the next
deploy. Nothing is deleted.

Dropped versions leave the switcher and their URLs 404. Pick N so that the versions people
actually link to stay in — and note that prereleases occupy slots too: blueapi's newest 20
releases include 5 prereleases, so `max-releases: 20` publishes only 15 real ones.

## What isn't capped

- **The default branch** — always published; it is the one required version.
- **The migration seed release** (`pages-default-seed`) — it stands in for the default
  branch rather than being a version of its own.
- **Open-PR previews** — naturally bounded by how many PRs you have open, and they leave
  as PRs close. blueapi's 26 open PRs are about 91 MB.
- **Releases with no `docs.zip` asset** — never published in the first place, and they do
  not consume a slot.

## Related

- [choose-publish-events](choose-publish-events.md) — how often deploys run
- [architecture](../explanations/architecture.md#why-the-site-has-a-size-limit) — why
  reconstruct-everything has this cost at all
