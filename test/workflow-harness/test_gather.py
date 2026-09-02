"""Behaviour tests for publish-gh-pages.yml's gather steps. See run.py for how they load."""

import os, re, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fixtures import ARTIFACTS, PRS, RELEASES, art, rel
from run import run, setup, steps_of

fails = []


def check(name, cond, detail=""):
    print(("  ok   - " if cond else "  FAIL - ") + name + (f"\n         {detail}" if not cond and detail else ""))
    if not cond:
        fails.append(name)


def do(tmp, maxrel="0", maxprs="0", **kw):
    """Run the three gather steps in order against one synthetic repo."""
    env, rt, data = setup(tmp, RELEASES, ARTIFACTS, PRS, **kw)
    exprs = {"github.token": "t", "inputs.max-releases": maxrel,
             "inputs.max-prs": maxprs, "runner.temp": rt}
    r1 = run("Select releases to publish", env, exprs)
    assert r1.returncode == 0, r1.stderr
    r2 = run("Gather release artifacts", env, exprs)
    r3 = run("Gather branch CI artifacts", env, exprs)
    return env, rt, data, r1, r2, r3


def log(r):
    """Everything the step wrote to the workflow log: assemble.mjs decisions land on
    stderr, the download warnings on stdout."""
    return r.stdout + r.stderr

print("\n-- unlimited: all valid releases gathered, junk skipped --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data, r1, r2, r3 = do(tmp)
    check("gather steps exit 0", r2.returncode == 0 and r3.returncode == 0, r2.stderr + r3.stderr)
    got = sorted(os.listdir(f"{rt}/gather"))
    check("releases + seed(main) + PR previews staged",
          got == ["1.0.zip", "2.0.zip", "3.0.zip", "main.zip", "pr-7.zip"], got)
    check("'/'-tag and asset-less release skipped", "release/x.zip" not in got and "0.9.zip" not in got)
    check("unapproved fork PR #8 skipped", "pr-8.zip" not in got)
    check("PR #9 with no artifact skipped", "pr-9.zip" not in got)
    check("main.zip came from branch CI, not the seed release",
          open(f"{rt}/gather/main.zip","rb").read() != open(f"{rt}/relcache/1.zip","rb").read())
    check("all release zips cached by asset id",
          sorted(os.listdir(f"{rt}/relcache")) == ["1.zip", "101.zip", "201.zip", "301.zip"],
          os.listdir(f"{rt}/relcache"))
    calls = open(env["MOCK_CALLS"]).read()
    check("artifacts API paginated exactly ONCE (was once per PR)",
          calls.count("actions/artifacts?name=docs") == 1,
          f"count={calls.count('actions/artifacts?name=docs')}")
    check("newest artifact per SHA wins",
          "artifacts/9001/zip" in calls and "artifacts/9000/zip" not in calls, calls)
    check("fork-owned same-named branch excluded", "artifacts/9002/zip" not in calls)
    # By ASSET ID, not by tag: the cache is id-addressed, so fetching `-p docs.zip` from
    # a tag could cache freshly re-cut bytes under the old id.
    check("release zips are fetched by asset id",
          "releases/assets/301" in calls and "release download" not in calls, calls)

print("\n-- the cache key comes from the selection, via GITHUB_OUTPUT --")
# The restore step reads BOTH of these: `key` for an exact hit, `restore-keys` for the
# prefix fallback to the previous selection. A missing/misspelt output silently degrades
# the cache to a permanent miss, which nothing else here would notice.
def cache_outputs(tmp, maxrel):
    env, rt, data = setup(tmp, RELEASES, [], [])
    ex = {"github.token": "t", "inputs.max-releases": maxrel, "runner.temp": rt}
    r = run("Select releases to publish", env, ex)
    assert r.returncode == 0, r.stderr
    return dict(l.split("=", 1) for l in open(env["GITHUB_OUTPUT"]).read().splitlines() if l)

with tempfile.TemporaryDirectory() as tmp:
    out = cache_outputs(tmp, "0")
    check("the step emits a cache-key",
          bool(re.fullmatch(r"mvs-relzips-v1-[0-9a-f]{32}", out.get("cache-key", ""))),
          out)
    check("the step emits the bare namespace for restore-keys",
          out.get("cache-prefix") == "mvs-relzips-v1-", out)
    check("the key sits under the prefix",
          out.get("cache-key", "").startswith(out.get("cache-prefix", "\0")), out)

with tempfile.TemporaryDirectory() as tmp:
    capped = cache_outputs(tmp, "2")
    with tempfile.TemporaryDirectory() as tmp2:
        uncapped = cache_outputs(tmp2, "0")
    check("capping changes the key but not the namespace",
          capped["cache-key"] != uncapped["cache-key"]
          and capped["cache-prefix"] == uncapped["cache-prefix"],
          f'{capped} vs {uncapped}')

print("\n-- cache hit: second run downloads nothing --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data, *_ = do(tmp)
    # rerun the release gather in the SAME runner temp: relcache is already populated
    exprs = {"github.token": "t", "inputs.max-releases": "0", "runner.temp": rt}
    open(env["MOCK_CALLS"], "w").close()
    r = run("Gather release artifacts", env, exprs)
    check("second run exits 0", r.returncode == 0, r.stderr)
    check("no release downloaded on a full cache hit",
          "release download" not in open(env["MOCK_CALLS"]).read())
    check("log reports all cached", "4 cached, 0 downloaded" in r.stdout, r.stdout[:400])

print("\n-- cap: only the newest N, seed exempt, cache pruned --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data, r1, r2, r3 = do(tmp, maxrel="2")
    got = sorted(os.listdir(f"{rt}/gather"))
    check("cap keeps the 2 newest releases", "3.0.zip" in got and "2.0.zip" in got and "1.0.zip" not in got, got)
    check("seed still supplies main", "main.zip" in got)
    check("cache holds only what is published",
          sorted(os.listdir(f"{rt}/relcache")) == ["1.zip", "201.zip", "301.zip"], os.listdir(f"{rt}/relcache"))
    check("cap decision is explained in the log", "beyond max-releases=2" in r2.stdout, r2.stdout[:300])

print("\n-- max-prs: newest builds win, an ineligible PR costs no slot --")
# A dedicated fixture: the shared one has only one eligible PR, so no cap could bite.
CAP_PRS = [(20, "sha20", False), (21, "sha21", False), (22, "sha22", False),
           (23, "sha23", False), (24, "sha24", True)]
CAP_ARTS = [art(1020, "sha20", "2026-05-01T00:00:00Z"),
            art(1021, "sha21", "2026-05-03T00:00:00Z"),
            art(1022, "sha22", "2026-05-02T00:00:00Z"),
            # 23 has no artifact at all; 24 is an unapproved fork.
            art(1024, "sha24", "2026-05-04T00:00:00Z")]

def cap_prs(tmp, maxprs):
    env, rt, data = setup(tmp, [], CAP_ARTS, CAP_PRS)
    ex = {"github.token": "t", "inputs.max-prs": maxprs, "runner.temp": rt}
    return run("Gather branch CI artifacts", env, ex), rt

with tempfile.TemporaryDirectory() as tmp:
    r, rt = cap_prs(tmp, "2")
    got = sorted(os.listdir(f"{rt}/gather"))
    check("cap keeps the two most recently built PRs", got == ["pr-21.zip", "pr-22.zip"], got)
    check("the capped PR is explained", "PR #20 → skip: beyond max-prs=2" in log(r), log(r))
    check("a PR with no artifact does not consume a slot",
          "PR #23 → skip: no non-expired" in log(r), log(r))
    check("an unapproved fork PR does not consume a slot",
          "PR #24 → skip: fork PR" in log(r) and "pr-24.zip" not in got, log(r))
    check("the cap is reported alongside the PR count", "(max-prs=2)" in log(r), log(r))

with tempfile.TemporaryDirectory() as tmp:
    r, rt = cap_prs(tmp, "0")
    got = sorted(os.listdir(f"{rt}/gather"))
    check("max-prs 0 is unlimited",
          got == ["pr-20.zip", "pr-21.zip", "pr-22.zip"], got)
    check("no cap is announced when unlimited", "max-prs=" not in log(r), log(r))

print("\n-- failures are isolated, not fatal --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data, r1, r2, r3 = do(tmp, dlfail=["2.0"], artfail=[9100], artnodocs=[9001])
    check("release gather still exits 0", r2.returncode == 0, r2.stderr)
    check("artifact gather still exits 0", r3.returncode == 0, r3.stderr)
    got = sorted(os.listdir(f"{rt}/gather"))
    check("a failed release download does not block the others", "3.0.zip" in got and "1.0.zip" in got)
    check("the failed release is absent", "2.0.zip" not in got, got)
    check("failed download is warned", "::warning::release 2.0" in r2.stdout, r2.stdout[-400:])
    # `gh api > file` writes the error body before exiting non-zero, so "nothing left
    # behind" needs the zip-magic check as well as the exit status.
    check("failed release is NOT left in the cache", "201.zip" not in os.listdir(f"{rt}/relcache"))
    check("artifact download failure warned", "artifact 9100 download failed" in log(r3), log(r3)[-500:])
    check("artifact without docs.zip warned distinctly", "has no docs.zip inside" in log(r3), log(r3)[-500:])
    check("that warning names both causes, not just the historical one",
          "re-run that build" in log(r3) and "also named docs" in log(r3), log(r3)[-600:])
    check("main falls back to the seed release when its artifact is bad", "main.zip" in got, got)

print("\n-- a malformed cap fails the deploy rather than silently unlimiting it --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data = setup(tmp, RELEASES, ARTIFACTS, PRS)
    r = run("Select releases to publish", env,
            {"github.token": "t", "inputs.max-releases": "3O", "runner.temp": rt})
    check("select-releases exits non-zero on a mistyped cap", r.returncode != 0, log(r))
    check("and says what it wanted", "non-negative integer" in log(r), log(r))

print("\n-- more open PRs than the gather even looks at --")
with tempfile.TemporaryDirectory() as tmp:
    many = [(n, f"sha{n}", False) for n in range(1, 201)]
    env, rt, data = setup(tmp, [], [], many)
    r = run("Gather branch CI artifacts", env,
            {"github.token": "t", "inputs.max-prs": "0", "runner.temp": rt})
    check("a truncated PR listing is warned about",
          "::warning::more than 200 open PRs" in log(r), log(r)[-400:])

print("\n-- empty repo: no releases, no artifacts, no PRs --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data = setup(tmp, [], [], [])
    exprs = {"github.token": "t", "inputs.max-releases": "0", "runner.temp": rt}
    a = run("Select releases to publish", env, exprs)
    b = run("Gather release artifacts", env, exprs)
    c = run("Gather branch CI artifacts", env, exprs)
    # Also the guard on xargs -r: without it, an empty selection runs the worker once
    # with no args, `set -u` trips on $1, and pipefail fails the whole deploy.
    check("all three steps survive an empty repo",
          a.returncode == 0 and b.returncode == 0 and c.returncode == 0,
          a.stderr + b.stderr + c.stderr)
    check("nothing staged", os.listdir(f"{rt}/gather") == [])

print("\n-- default-branch fallback chain --")
import subprocess

def ensure(tmp, *, gathered=None, cached=None):
    """Run Ensure-default-branch-zip with a chosen rung populated."""
    env, rt, data = setup(tmp, [], [], [])
    ex = {"github.token": "t", "runner.temp": rt}
    for path, marker in ((f"{rt}/gather/main.zip", gathered),
                         (f"{rt}/defaultcache/default.zip", cached)):
        if marker:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            subprocess.run([f"{data}/mkzip.sh", path, marker], check=True)
    return run("Ensure default-branch zip", env, ex), rt, env

with tempfile.TemporaryDirectory() as tmp:
    r, rt, env = ensure(tmp, gathered="fresh")
    check("a gathered main.zip wins", r.returncode == 0 and "supplied by an earlier rung" in r.stdout, r.stdout + r.stderr)
    check("a fresh main.zip is written to the cache dir", os.path.exists(f"{rt}/defaultcache/default.zip"))
    out = open(env["GITHUB_OUTPUT"]).read()
    check("a fresh main.zip requests a cache save", "cache-key=mvs-default-v1-" in out, out)

with tempfile.TemporaryDirectory() as tmp:
    r, rt, _ = ensure(tmp, cached="cached")
    check("falls back to the Actions cache when CI artifact is gone",
          r.returncode == 0 and "restored from the Actions cache" in r.stdout, r.stdout + r.stderr)
    check("the cached zip is staged", os.path.exists(f"{rt}/gather/main.zip"))

with tempfile.TemporaryDirectory() as tmp:
    r, rt, _ = ensure(tmp)
    check("hard-fails when no rung supplies the default branch", r.returncode != 0)
    check("the failure names every rung tried", "the Actions cache" in r.stdout and "deploy aborted" in r.stdout, r.stdout)

with tempfile.TemporaryDirectory() as tmp:
    # Same bytes already cached => no new immutable cache entry requested.
    env, rt, data = setup(tmp, [], [], [])
    ex = {"github.token": "t", "runner.temp": rt}
    os.makedirs(f"{rt}/defaultcache", exist_ok=True)
    subprocess.run([f"{data}/mkzip.sh", f"{rt}/gather/main.zip", "same"], check=True)
    subprocess.run([f"{data}/mkzip.sh", f"{rt}/defaultcache/default.zip", "same"], check=True)
    import hashlib
    h = hashlib.sha256(open(f"{rt}/gather/main.zip","rb").read()).hexdigest()[:32]
    open(f"{rt}/defaultcache/default.sha","w").write(h)
    r = run("Ensure default-branch zip", env, ex)
    check("an unchanged default branch requests no cache save",
          r.returncode == 0 and "cache-key=" not in open(env["GITHUB_OUTPUT"]).read(),
          open(env["GITHUB_OUTPUT"]).read())

print("\n-- the parallel download passes rows as data, not as script text --")
# The worker used to be `xargs -I{}`, which pastes each row into the script TEXT. Git
# permits $ and () in a branch name, so a branch could smuggle a command substitution
# into the label. Positional args make it inert; assert it stays that way.
with tempfile.TemporaryDirectory() as tmp:
    hostile = "br$(id -u)x"
    env, rt, data = setup(tmp, [], [art(5000, "sha5000", "2026-05-01T00:00:00Z", branch=hostile)],
                          [], artfail=[5000])
    env["DEFAULT"] = hostile
    r = run("Gather branch CI artifacts", env, {"github.token": "t", "runner.temp": rt})
    check("the branch name reaches the warning verbatim", hostile in log(r), log(r)[-400:])
    check("the command substitution in it is never executed",
          f"br{os.getuid()}x" not in log(r), log(r)[-400:])

# The worker's argument wiring: `bash -c` takes the arg AFTER the script as $0, so if
# that placeholder is ever dropped, dest lands in $0 and every field shifts by one. A
# space-bearing label is the case that shows it — the row still parses, it just lands in
# the wrong place.
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data = setup(tmp, [], [art(6000, "sha6000", "2026-05-01T00:00:00Z", branch="main")], [])
    r = run("Gather branch CI artifacts", env, {"github.token": "t", "runner.temp": rt})
    check("a row whose label contains spaces still stages at its own dest",
          os.listdir(f"{rt}/gather") == ["main.zip"],
          f'{os.listdir(f"{rt}/gather")} — label was {"default-branch CI (main)"!r}')

print("\n-- the version-name contract: both sides derive the same string --")
# docs.yml builds at BASE_URL=/repo/<version-name> and the gather independently stages
# each source at site/<version-name>. Nothing is passed between them, so the ONLY thing
# keeping a build's assets from 404ing is that the two rules agree. Pin them together.
DOCS = steps_of("docs.yml", "build")

def docs_yml_version(tmp, event, *, ref_name="", pr_number="", base_path="", repo="widget"):
    """Run docs.yml's own compute step; return (version-name, BASE_URL, result)."""
    # A fresh pair per call (the step appends), named by a counter rather than by the
    # ref — one of the refs under test contains a '/'.
    docs_yml_version.n = getattr(docs_yml_version, "n", 0) + 1
    out = os.path.join(tmp, f"ver-{docs_yml_version.n}.txt")
    genv = os.path.join(tmp, f"env-{docs_yml_version.n}.txt")
    open(out, "w").close(); open(genv, "w").close()
    env = dict(os.environ, GITHUB_OUTPUT=out, GITHUB_ENV=genv)
    exprs = {"github.event_name": event, "github.ref_name": ref_name,
             "github.event.pull_request.number": pr_number,
             "inputs.base-path": base_path, "github.event.repository.name": repo}
    r = run("Compute version name and BASE_URL", env, exprs, from_steps=DOCS)
    def value(path, key):
        for line in open(path):
            if line.startswith(f"{key}="):
                return line.strip().split("=", 1)[1]
        return None
    return value(out, "version-name"), value(genv, "BASE_URL"), r


def docs_yml_version_name(tmp, event, **kw):
    name, _, r = docs_yml_version(tmp, event, **kw)
    assert r.returncode == 0, r.stderr
    return name

with tempfile.TemporaryDirectory() as tmp:
    # A tag: docs.yml uses the ref name; the gather uses the release's tag.
    built = docs_yml_version_name(tmp, "push", ref_name="1.2.3")
    env, rt, data = setup(tmp, [rel("1.2.3", "2026-01-01T00:00:00Z", 555)], [], [])
    ex = {"github.token": "t", "inputs.max-releases": "0", "runner.temp": rt}
    assert run("Select releases to publish", env, ex).returncode == 0
    dest = open(f"{rt}/releases.tsv").read().split("\t")[1]
    check(f"a tag builds and is staged at the same name ({built!r})", built == dest,
          f"docs.yml says {built!r}, the gather stages at {dest!r}")

with tempfile.TemporaryDirectory() as tmp:
    # A PR: docs.yml uses pr-<n>; the gather uses the PR number from `gh pr list`.
    built = docs_yml_version_name(tmp, "pull_request", pr_number="7")
    env, rt, data = setup(tmp, [], [art(7001, "pr7sha", "2026-01-01T00:00:00Z")],
                          [(7, "pr7sha", False)])
    r = run("Gather branch CI artifacts", env, {"github.token": "t", "runner.temp": rt})
    staged = [f[:-4] for f in os.listdir(f"{rt}/gather")]
    check(f"a PR builds and is staged at the same name ({built!r})", staged == [built],
          f"docs.yml says {built!r}, the gather staged {staged}")

with tempfile.TemporaryDirectory() as tmp:
    # The default branch: docs.yml uses the ref name, the gather uses default_branch.
    built = docs_yml_version_name(tmp, "push", ref_name="main")
    env, rt, data = setup(tmp, [], [art(8001, "mainsha", "2026-01-01T00:00:00Z", branch="main")], [])
    r = run("Gather branch CI artifacts", env, {"github.token": "t", "runner.temp": rt})
    staged = [f[:-4] for f in os.listdir(f"{rt}/gather")]
    check(f"the default branch builds and is staged at the same name ({built!r})",
          staged == [built], f"docs.yml says {built!r}, the gather staged {staged}")

print("\n-- extract: the zip-shape contract --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data = setup(tmp, [], [], [])
    ex = {"github.token": "t", "runner.temp": rt}
    subprocess.run([f"{data}/mkzip.sh", f"{rt}/gather/main.zip", "main"], check=True)
    subprocess.run([f"{data}/mkzip.sh", f"{rt}/gather/1.0.zip", "onepointoh"], check=True)
    open(f"{rt}/gather/broken.zip", "w").write("not a zip")
    # Two roots => malformed, must warn and skip rather than guess.
    d2 = os.path.join(tmp, "two"); os.makedirs(f"{d2}/a"); os.makedirs(f"{d2}/b")
    subprocess.run(["zip", "-rq", f"{rt}/gather/tworoots.zip", "a", "b"], cwd=d2, check=True)
    r = run("Extract artifacts into site", env, ex)
    got = sorted(os.listdir(f"{rt}/site"))
    check("extract exits 0 despite malformed zips", r.returncode == 0, r.stderr)
    check("only well-formed zips become version dirs", got == ["1.0", "main"], got)
    check("an unreadable zip warns", "could not unzip" in r.stdout, r.stdout)
    check("a two-root zip warns", "exactly one top-level directory" in r.stdout, r.stdout)

with tempfile.TemporaryDirectory() as tmp:
    # BASE_URL is the other half of the same contract: the version name has to be
    # appended to wherever the SITE is served, which is not always /<repo>.
    _, base, r = docs_yml_version(tmp, "push", ref_name="main")
    check("BASE_URL defaults to /<repo>/<version>", base == "/widget/main", f"{base!r} {log(r)}")
    _, base, _ = docs_yml_version(tmp, "push", ref_name="main", base_path="/")
    check("base-path '/' roots the build at the host root (custom domain)",
          base == "/main", repr(base))
    _, base, _ = docs_yml_version(tmp, "push", ref_name="main", base_path="docs/")
    check("base-path slashes are normalised", base == "/docs/main", repr(base))

with tempfile.TemporaryDirectory() as tmp:
    # The name becomes a URL path segment and a site dir. docs.yml is reusable, so a
    # consumer can point it at any ref, and git allows $( ) and quotes in a ref name.
    for bad in ("feature/x", "v1-$(id)", "", "."):
        _, _, r = docs_yml_version(tmp, "push", ref_name=bad)
        check(f"an unusable version name is rejected ({bad!r})",
              r.returncode != 0 and "not usable as a URL path segment" in log(r), log(r))

with tempfile.TemporaryDirectory() as tmp:
    # merge_group's ref_name is GitHub's own gh-readonly-queue/<base>/pr-<n>-<sha> —
    # it contains '/' and would otherwise fail the same check as "feature/x" above.
    # This build is never gathered (the gather never reads a merge queue's temporary
    # branch), so a fixed, valid name is enough — no need to parse GitHub's ref.
    built = docs_yml_version_name(
        tmp, "merge_group",
        ref_name="gh-readonly-queue/main/pr-1645-579cb18403ab661103b5e1093396e45b2e91939f")
    check(f"a merge_group build gets a fixed, valid name ({built!r})",
          built == "merge-queue", built)

print("\n-- linking the published docs back to the triggering commit --")
def link(tmp, *, dirs=(), built_branch="main", **exprs):
    env, rt, data = setup(tmp, [], [], [])
    env["BUILT_BRANCH"] = built_branch
    for d in dirs:
        os.makedirs(f"{rt}/site/{d}", exist_ok=True)
    ex = {"github.token": "t", "runner.temp": rt,
          "steps.deployment.outputs.page_url": "https://acme.github.io/widget/"}
    ex.update(exprs)
    r = run("Link the published docs from the triggering commit", env, ex)
    return r, open(env["MOCK_CALLS"]).read()

with tempfile.TemporaryDirectory() as tmp:
    r, calls = link(tmp, dirs=["pr-7"],
                    **{"github.event.workflow_run.event": "pull_request",
                       "github.event.workflow_run.head_sha": "deadbeef",
                       "github.event.workflow_run.pull_requests[0].number": "7"})
    check("a PR build is linked at its own version dir",
          "statuses/deadbeef" in calls and "https://acme.github.io/widget/pr-7/" in calls,
          calls)
    check("the status is a success, never a failure",
          "state=success" in calls and "state=failure" not in calls, calls)

with tempfile.TemporaryDirectory() as tmp:
    # A payload with no pull_requests falls through to the branch name, which is not a
    # version dir — post nothing rather than a link that 404s.
    r, calls = link(tmp, dirs=["pr-7"], built_branch="feature/x",
                    **{"github.event.workflow_run.event": "pull_request",
                       "github.event.workflow_run.head_sha": "deadbeef"})
    check("an unresolvable PR posts no status at all",
          r.returncode == 0 and "statuses/" not in calls, calls + log(r))
    check("and says why", "not linking" in log(r), log(r))

with tempfile.TemporaryDirectory() as tmp:
    r, calls = link(tmp, dirs=["main"],
                    **{"github.event.workflow_run.event": "push",
                       "github.event.workflow_run.head_sha": "cafe1234"})
    check("a default-branch build is linked too",
          "statuses/cafe1234" in calls and "widget/main/" in calls, calls)

with tempfile.TemporaryDirectory() as tmp:
    # A manual re-deploy has no triggering commit to hang a status on.
    r, calls = link(tmp, dirs=["main"])
    check("a manual re-deploy posts nothing and still succeeds",
          r.returncode == 0 and "statuses/" not in calls, calls + log(r))

with tempfile.TemporaryDirectory() as tmp:
    # Fork preview: the maintainer named the PR, so inputs.pr and the pinned SHA win.
    r, calls = link(tmp, dirs=["pr-42"],
                    **{"inputs.pr": "42", "steps.approve.outputs.sha": "f0rk5haa"})
    check("a dispatched fork preview is linked at the approved SHA",
          "statuses/f0rk5haa" in calls and "widget/pr-42/" in calls, calls)

print("\n-- generate: the deploy stamp and the size report --")
with tempfile.TemporaryDirectory() as tmp:
    # Runs the real step, so assemble.mjs's `git tag` reads THIS repo — no tag of ours is
    # a deployed dir here, so there is no stable/ alias and the site is just the branch.
    env, rt, data = setup(tmp, [], [], [])
    os.makedirs(f"{rt}/site/main", exist_ok=True)
    env["PAGES_URL"] = "https://acme.github.io/widget"
    r = run("Generate switcher.json and stable alias", env, {"runner.temp": rt})
    check("generate exits 0", r.returncode == 0, log(r))
    check("writes switcher.json", os.path.exists(f"{rt}/site/switcher.json"))
    stamp = f"{rt}/site/deploy-id.txt"
    check("stamps the deploy with something unique to this run",
          os.path.exists(stamp) and "run=" in open(stamp).read(),
          open(stamp).read() if os.path.exists(stamp) else "missing")
    # The size is reported HERE, not in the extract step: it has to be measured after
    # the stable/ symlink exists, and with -L, or it under-reports by a whole release.
    check("reports the assembled size after the alias", "assembled site:" in log(r), log(r))

print("\n-- the origin verify catches a wedge the switcher.json alone cannot --")
# The step polls for ~6 min before giving up, so shorten the deadline. This is the same
# kind of substitution run.py already does for ${{ }}: one asserted literal, in a body
# still loaded from the YAML.
def verify(tmp, *, origin, assembled=None):
    """Run the verify step against a mock origin. `origin` is what the site SERVES;
    `assembled` (default: the same) is what this deploy built."""
    env, rt, data = setup(tmp, [], [], [])
    assembled = origin if assembled is None else assembled
    for name, text in assembled.items():
        open(f"{rt}/site/{name}", "w").write(text)
    env["MOCK_ORIGIN"] = os.path.join(tmp, "origin")
    os.makedirs(env["MOCK_ORIGIN"], exist_ok=True)
    for name, text in origin.items():
        open(f"{env['MOCK_ORIGIN']}/{name}", "w").write(text)
    step = dict(steps_of("publish-gh-pages.yml", "deploy")["Verify the deployed origin matches what we assembled"])
    assert "timeout_s=360" in step["run"]
    step["run"] = step["run"].replace("timeout_s=360", "timeout_s=6")
    r = run("v", env, {"steps.deployment.outputs.page_url": "https://acme.github.io/widget/",
                       "runner.temp": rt}, from_steps={"v": step})
    return r

SWITCHER = '[{"version": "main", "url": "https://acme.github.io/widget/main/"}]'
THIS = "run=42\nattempt=1\nutc=2026-08-25T10:00:00Z\n"
PREV = "run=41\nattempt=1\nutc=2026-08-24T10:00:00Z\n"

with tempfile.TemporaryDirectory() as tmp:
    r = verify(tmp, origin={"switcher.json": SWITCHER, "deploy-id.txt": THIS})
    check("passes on the first attempt when the origin is serving this deploy",
          r.returncode == 0 and "attempt 1)" in log(r), log(r))

with tempfile.TemporaryDirectory() as tmp:
    # THE case the switcher.json comparison is blind to: an ordinary docs edit on the
    # default branch leaves the version set — and so switcher.json — byte-identical,
    # while the origin still serves the previous deploy.
    r = verify(tmp, origin={"switcher.json": SWITCHER, "deploy-id.txt": PREV},
               assembled={"switcher.json": SWITCHER, "deploy-id.txt": THIS})
    check("fails when only the deploy stamp is stale",
          r.returncode != 0 and "deploy-id.txt still does not match" in log(r), log(r))
    check("and still dumps the origin headers", "etag" in log(r).lower(), log(r))

with tempfile.TemporaryDirectory() as tmp:
    # A current stamp but a stale switcher.json is a partially-served deploy.
    r = verify(tmp, origin={"switcher.json": "[]", "deploy-id.txt": THIS},
               assembled={"switcher.json": SWITCHER, "deploy-id.txt": THIS})
    check("fails when the stamp is current but switcher.json is not",
          r.returncode != 0 and "switcher.json still does not match" in log(r), log(r))

with tempfile.TemporaryDirectory() as tmp:
    # Nothing assembled to compare against: fail loudly rather than pass vacuously.
    r = verify(tmp, origin={}, assembled={})
    check("fails when there is nothing to verify against",
          r.returncode != 0 and "nothing to verify against" in log(r), log(r))

print(f"\n{'FAILURES: ' + ', '.join(fails) if fails else 'all harness checks passed'}")
sys.exit(1 if fails else 0)
