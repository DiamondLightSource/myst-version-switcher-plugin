"""
Structural invariants of the publish workflows.

The gather bash is covered by test_gather.py. What that harness cannot reach are the
`if:` expressions and the wiring between the three files, which GitHub evaluates rather
than a shell. Each assertion here stands for a way that wiring can break silently.
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
check("exposes exactly pr + max-releases + max-prs",
      sorted(engine_on["workflow_call"]["inputs"]) == ["max-prs", "max-releases", "pr"],
      sorted(engine_on["workflow_call"]["inputs"]))
check("is a single deploy job", list(engine["jobs"]) == ["deploy"], list(engine["jobs"]))

steps = engine["jobs"]["deploy"]["steps"]
names = [s.get("name", s.get("uses", "")) for s in steps]
check("verifies the deployed origin", any("Verify" in n for n in names), names)

# THE workflow_run trap. github.ref is ALWAYS the default branch — even when a PR's CI
# triggered the run — so a save gated on it would fire for every deploy, including one
# dispatched from another ref, whose entry only that ref can read. head_branch is the
# only honest answer to "was this the default branch?".
saves = [s for s in steps if "cache/save" in str(s.get("uses", ""))]
check("both caches have a save step", len(saves) == 2, f"found {len(saves)}")
for s in saves:
    cond = str(s.get("if", ""))
    check(f"{s['name']!r} does not gate on github.ref",
          "github.ref ==" not in cond and "format('refs/heads/" not in cond, cond)
    check(f"{s['name']!r} gates on the branch that was built",
          "workflow_run.head_branch" in cond, cond)

# The PR-visible status must never be able to go red: publishing lives off the PR's
# critical path because a wedged Pages origin is not the author's to fix, and a status
# that could fail would hand that back to them.
link = next((s for s in steps if s.get("name", "").startswith("Link the published")), None)
check("there is a step linking the docs back to the triggering commit", link is not None)
if link:
    check("it only runs when the deploy succeeded", "success()" in str(link.get("if", "")),
          link.get("if"))
    check("it can only ever post a success state",
          "state=success" in link["run"] and "state=failure" not in link["run"]
          and "state=error" not in link["run"])

check("deploy cancels superseded runs",
      engine["jobs"]["deploy"]["concurrency"].get("cancel-in-progress") is True,
      engine["jobs"]["deploy"]["concurrency"])
check("deploy holds no write token beyond what it deploys with",
      engine["jobs"]["deploy"]["permissions"]["actions"] == "read"
      and engine["jobs"]["deploy"]["permissions"]["contents"] == "read",
      engine["jobs"]["deploy"]["permissions"])

print("\n-- caller: publish.yml --")
check("triggers on workflow_run + workflow_dispatch",
      sorted(caller_on) == ["workflow_dispatch", "workflow_run"], sorted(caller_on))
check("listens for the CI workflow by name",
      caller_on["workflow_run"]["workflows"] == [ci["name"]],
      f'{caller_on["workflow_run"]["workflows"]} vs ci name {ci["name"]!r}')

guard = str(caller["jobs"]["publish"]["if"])
# workflow_run hands a WRITE token to a job triggered by fork-PR code. Losing either half
# of this guard is a pwn-request, and it fails open rather than loudly.
check("requires the triggering run to have succeeded",
      "conclusion == 'success'" in guard, guard)
check("excludes forks", "head_repository.full_name == github.repository" in guard, guard)
check("still allows a manual dispatch", "workflow_dispatch" in guard, guard)

# Site-size policy has to hold on EVERY path into the engine, and this workflow is its
# only caller — an expression here could be emptied by a manual dispatch.
with_block = caller["jobs"]["publish"]["with"]
for cap in ("max-releases", "max-prs"):
    val = str(with_block.get(cap, ""))
    check(f"{cap} is set as a literal", val.isdigit(), repr(val))

print("\n-- entry: ci.yml --")
check("builds without publishing", "publish" not in ci["jobs"], list(ci["jobs"]))
check("uploads the docs artifact the engine gathers", "docs" in ci["jobs"], list(ci["jobs"]))

print("\n" + ("FAILURES: " + ", ".join(fails) if fails else "all shape checks passed"))
sys.exit(1 if fails else 0)
