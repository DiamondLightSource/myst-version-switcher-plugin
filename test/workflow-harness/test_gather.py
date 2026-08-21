"""Behaviour tests for publish-gh-pages.yml's gather steps. See run.py for how they load."""

import os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fixtures import ARTIFACTS, PRS, RELEASES
from run import run, setup

fails = []


def check(name, cond, detail=""):
    print(("  ok   - " if cond else "  FAIL - ") + name + (f"\n         {detail}" if not cond and detail else ""))
    if not cond:
        fails.append(name)


def do(tmp, maxrel="0", **kw):
    """Run the three gather steps in order against one synthetic repo."""
    env, rt, data = setup(tmp, RELEASES, ARTIFACTS, PRS, **kw)
    exprs = {"github.token": "t", "inputs.max-releases": maxrel, "runner.temp": rt}
    r1 = run("Select releases to publish", env, exprs)
    assert r1.returncode == 0, r1.stderr
    r2 = run("Gather release artifacts", env, exprs)
    r3 = run("Gather branch CI artifacts", env, exprs)
    return env, rt, data, r1, r2, r3

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
    check("newest artifact per SHA wins", "artifacts/9001/zip" in calls and "artifacts/9000/zip" not in calls)
    check("fork-owned same-named branch excluded", "artifacts/9002/zip" not in calls)

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
    check("log reports all cached", "4 cached, 0 to download" in r.stdout, r.stdout[:400])

print("\n-- cap: only the newest N, seed exempt, cache pruned --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data, r1, r2, r3 = do(tmp, maxrel="2")
    got = sorted(os.listdir(f"{rt}/gather"))
    check("cap keeps the 2 newest releases", "3.0.zip" in got and "2.0.zip" in got and "1.0.zip" not in got, got)
    check("seed still supplies main", "main.zip" in got)
    check("cache holds only what is published",
          sorted(os.listdir(f"{rt}/relcache")) == ["1.zip", "201.zip", "301.zip"], os.listdir(f"{rt}/relcache"))
    check("cap decision is explained in the log", "beyond max-releases=2" in r2.stdout, r2.stdout[:300])

print("\n-- failures are isolated, not fatal --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data, r1, r2, r3 = do(tmp, dlfail=["2.0"], artfail=[9100], artnodocs=[9001])
    check("release gather still exits 0", r2.returncode == 0, r2.stderr)
    check("artifact gather still exits 0", r3.returncode == 0, r3.stderr)
    got = sorted(os.listdir(f"{rt}/gather"))
    check("a failed release download does not block the others", "3.0.zip" in got and "1.0.zip" in got)
    check("the failed release is absent", "2.0.zip" not in got, got)
    check("failed download is warned", "::warning::release 2.0" in r2.stdout, r2.stdout[-400:])
    check("failed release is NOT left in the cache", "201.zip" not in os.listdir(f"{rt}/relcache"))
    check("artifact download failure warned", "artifact 9100 download failed" in r3.stdout, r3.stdout[-500:])
    check("artifact without docs.zip warned distinctly", "contains no docs.zip" in r3.stdout, r3.stdout[-500:])
    check("main falls back to the seed release when its artifact is bad", "main.zip" in got, got)

print("\n-- empty repo: no releases, no artifacts, no PRs --")
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data = setup(tmp, [], [], [])
    exprs = {"github.token": "t", "inputs.max-releases": "0", "runner.temp": rt}
    a = run("Select releases to publish", env, exprs)
    b = run("Gather release artifacts", env, exprs)
    c = run("Gather branch CI artifacts", env, exprs)
    check("all three steps survive an empty repo",
          a.returncode == 0 and b.returncode == 0 and c.returncode == 0,
          a.stderr + b.stderr + c.stderr)
    check("nothing staged", os.listdir(f"{rt}/gather") == [])

print("\n-- default-branch fallback chain --")
import subprocess

def ensure(tmp, *, gathered=None, cached=None, in_site=None):
    """Run Ensure-default-branch-zip with a chosen rung populated."""
    env, rt, data = setup(tmp, [], [], [])
    ex = {"github.token": "t", "runner.temp": rt}
    env["PAGES_URL"] = in_site or "http://127.0.0.1:1"   # unroutable => the curl rung fails
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
    env["PAGES_URL"] = "http://127.0.0.1:1"
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

print("\n-- extract: zip shape contract and the size guard --")
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
    check("_sources is no longer published into the site", "_sources" not in got, got)
    check("an unreadable zip warns", "could not unzip" in r.stdout, r.stdout)
    check("a two-root zip warns", "exactly one top-level directory" in r.stdout, r.stdout)
    check("the site size is reported", "assembled site:" in r.stdout, r.stdout)
    check("a small site does not trip the 1 GB warning",
          "approaching the Pages 1 GB limit" not in r.stdout)
    check("a small site is not packed just to measure it",
          "packed artifact:" not in r.stdout, r.stdout)

# The guard's whole point is the warning, and it compares the PACKED size — measuring
# the tree with du would cry wolf, since HTML/JS packs ~3x (this repo's own site is
# 734 MiB on disk and 223 MiB deployed). Dial the thresholds down rather than build a
# multi-gigabyte fixture.
with tempfile.TemporaryDirectory() as tmp:
    env, rt, data = setup(tmp, [], [], [])
    ex = {"github.token": "t", "runner.temp": rt}
    subprocess.run([f"{data}/mkzip.sh", f"{rt}/gather/main.zip", "main"], check=True)
    env["SIZE_PROBE_BYTES"] = "1"        # always pack
    env["SIZE_WARN_BYTES"] = "1"         # always warn
    r = run("Extract artifacts into site", env, ex)
    check("past the probe threshold the tree is actually packed",
          "packed artifact:" in r.stdout, r.stdout)
    check("past the warn threshold a warning is emitted",
          "::warning title=Docs site approaching the Pages 1 GB limit" in r.stdout, r.stdout)
    check("the warning names max-releases as the lever", "max-releases" in r.stdout, r.stdout)

with tempfile.TemporaryDirectory() as tmp:
    env, rt, data = setup(tmp, [], [], [])
    ex = {"github.token": "t", "runner.temp": rt}
    subprocess.run([f"{data}/mkzip.sh", f"{rt}/gather/main.zip", "main"], check=True)
    env["SIZE_PROBE_BYTES"] = "1"        # pack it...
    env["SIZE_WARN_BYTES"] = str(10**12)  # ...but it is nowhere near the cap
    r = run("Extract artifacts into site", env, ex)
    check("a packed site under the cap reports but does not warn",
          "packed artifact:" in r.stdout and "approaching the Pages 1 GB limit" not in r.stdout,
          r.stdout)

print(f"\n{'FAILURES: ' + ', '.join(fails) if fails else 'all harness checks passed'}")
sys.exit(1 if fails else 0)
