# How-to: serve the site from a custom domain

A GitHub Pages **project site** is served at `https://ORG.github.io/REPO/`, so every
version lives under `/REPO/`. Two setups break that assumption — both serve from the
**root** of their host:

- a **custom domain** (a `CNAME` on the repo's Pages settings), e.g.
  `https://docs.example.org/`
- an **`ORG.github.io` / `USER.github.io` repo**, whose Pages site *is* the host root

In either case the built HTML must be rooted at `/`, not at `/REPO/`, or every
root-absolute asset and link in it 404s.

## Set `base-path`

One input on `docs.yml`, in your `ci.yml`:

```yaml
jobs:
  docs:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/docs.yml@<tag>
    with:
      build-command: make docs
      base-path: "/"          # ← the site is served at the root, not at /REPO/
```

The build then runs with `BASE_URL=/<version-name>` — `/main`, `/pr-12`, `/2.1` — which
is where those pages actually live on a root-served site.

`base-path` is the path to the *site*, without the version segment. It defaults to
`/<repo>`. Leading and trailing slashes are normalised, so `/`, `/docs` and `docs/` all
work.

## Nothing else changes

`publish.yml` needs no configuration for this. It reads the site's live URL from the
**Pages API**, which already reports the custom domain, and bakes that into
`switcher.json`'s entries — so the switcher's links follow the domain automatically.

That split is worth knowing when debugging: a site whose **switcher links are right but
whose pages are broken** (missing CSS, 404s on every internal link) is a `base-path` that
was never set. The Pages API told the publish half the truth; nobody told the build half.

## Checklist

1. Add the domain in **Settings → Pages → Custom domain** (or use an `ORG.github.io`
   repo) and let the DNS check pass.
2. Set `base-path: "/"` on the `docs.yml` job.
3. Re-run CI on the default branch, then let `publish.yml` deploy.
4. Open the site and check that a version's CSS loads and that the switcher's entries
   point at the custom domain.

## Related

- [workflows reference](../reference/workflows.md) — the full `docs.yml` input table
- [use-with-sphinx](use-with-sphinx.md) — the same `BASE_URL` contract from a Sphinx build
