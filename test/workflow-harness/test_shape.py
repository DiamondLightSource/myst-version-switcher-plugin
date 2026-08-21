"""
Structural invariants of the publish workflows.

The gather bash is covered by test_gather.py. What that harness cannot reach are the
`if:` expressions, which are evaluated by GitHub, not by a shell — and those are where
the workflow_run migration is easiest to get quietly wrong. Each assertion here stands
for a specific way it has broken or could break.
"""

import os
import sys

import yaml

H = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(H))
WF = os.path.join(REPO, ".github", "workflows")

fails = []


def check(name, cond, detail=""):
    print(("  ok   - " if cond else "  FAIL - ") + name + (f"\n         {detail}" if not cond and detail else ""))
    if not cond:
        fails.append(name)


def load(name):
    with open(os.path.join(WF, name)) as f:
        return yaml.safe_load(f)


engine = load("publish-gh-pages.yml")
caller = load("publish.yml")
ci = load("ci.yml")
# PyYAML parses the bare key `on` as the boolean True.
engine_on, caller_on, ci_on = engine[True], caller[True], ci[True]

print("\n-- engine: publish-gh-pages.yml --")
check("is workflow_call only", list(engine_on) == ["workflow_call"], list(engine_on))
check("exposes only pr + max-releases",
      sorted(engine_on["workflow_call"]["inputs"]) == ["max-releases", "pr"],
      sorted(engine_on["workflow_call"]["inputs"]))
check("has a single deploy job (no re-dispatch, no warn)",
      list(engine["jobs"]) == ["deploy"], list(engine["jobs"]))

steps = engine["jobs"]["deploy"]["steps"]
names = [s.get("name", s.get("uses", "")) for s in steps]
check("no in-run artifact injection remains",
      not any("this run's docs artifact" in n or "Stage current build" == n for n in names), names)
check("no wedged-origin retry remains", not any("Retry via" in n for n in names), names)
check("still verifies the deployed origin", any("Verify" in n for n in names), names)

# THE trap this migration introduces. Under workflow_run, github.ref is ALWAYS the
# default branch — even when a PR's CI triggered the run — so gating a cache SAVE on
# github.ref would have every PR-triggered deploy writing caches that nothing can read.
saves = [s for s in steps if "cache/save" in str(s.get("uses", ""))]
check("there are cache-save steps to check", len(saves) == 2, f"found {len(saves)}")
for s in saves:
    cond = str(s.get("if", ""))
    check(f"{s['name']!r} does not gate on github.ref",
          "github.ref ==" not in cond and "format('refs/heads/" not in cond, cond)
    check(f"{s['name']!r} gates on the branch that was built",
          "workflow_run.head_branch" in cond, cond)

check("deploy cancels superseded runs",
      engine["jobs"]["deploy"]["concurrency"].get("cancel-in-progress") is True,
      engine["jobs"]["deploy"]["concurrency"])
check("deploy no longer needs actions:write",
      engine["jobs"]["deploy"]["permissions"]["actions"] == "read",
      engine["jobs"]["deploy"]["permissions"])

print("\n-- caller: publish.yml --")
check("triggers on workflow_run + workflow_dispatch",
      sorted(caller_on) == ["workflow_dispatch", "workflow_run"], sorted(caller_on))
check("listens for the CI workflow by name",
      caller_on["workflow_run"]["workflows"] == [ci["name"]],
      f'{caller_on["workflow_run"]["workflows"]} vs ci name {ci["name"]!r}')

guard = str(caller["jobs"]["publish"]["if"])
# workflow_run hands a WRITE token to a job triggered by fork-PR code. Losing either
# half of this guard is the pwn-request footgun the old read-only warn job existed to
# avoid, and it would fail open rather than loudly.
check("requires the triggering run to have succeeded",
      "conclusion == 'success'" in guard, guard)
check("excludes forks", "head_repository.full_name == github.repository" in guard, guard)
check("still allows a manual dispatch",
      "workflow_dispatch" in guard, guard)

print("\n-- entry: ci.yml --")
check("no longer publishes", "publish" not in ci["jobs"], list(ci["jobs"]))
check("still uploads the docs artifact CI's consumers gather", "docs" in ci["jobs"], list(ci["jobs"]))

print("\n" + ("FAILURES: " + ", ".join(fails) if fails else "all shape checks passed"))
sys.exit(1 if fails else 0)
