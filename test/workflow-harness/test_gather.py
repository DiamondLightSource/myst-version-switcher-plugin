"""Behaviour tests for publish.yml's gather steps. See run.py for how they load."""

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

print(f"\n{'FAILURES: ' + ', '.join(fails) if fails else 'all harness checks passed'}")
sys.exit(1 if fails else 0)
