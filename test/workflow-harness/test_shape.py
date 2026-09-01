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

# Never cancel a deploy in flight: the kill lands somewhere inside deploy-pages, and
# the state on the far side of it is the Pages backend's, not ours.
check("deploy queues superseded runs rather than cancelling them",
      engine["jobs"]["deploy"]["concurrency"].get("cancel-in-progress") is False,
      engine["jobs"]["deploy"]["concurrency"])
check("deploys are serialised on one group",
      engine["jobs"]["deploy"]["concurrency"].get("group") == "pages",
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
check("excludes merge_group runs (never gathered, so a no-op redeploy)",
      "workflow_run.event != 'merge_group'" in guard, guard)
check("still allows a manual dispatch", "workflow_dispatch" in guard, guard)

# Site-size policy has to hold on EVERY path into the engine, and this workflow is its
# only caller — an expression here could be emptied by a manual dispatch.
with_block = caller["jobs"]["publish"]["with"]
for cap in ("max-releases", "max-prs"):
    val = str(with_block.get(cap, ""))
    check(f"{cap} is set as a literal", val.isdigit(), repr(val))

# ── Cross-cutting: every workflow file, every job ──────────────────────────────
#
# A context value interpolated into a `run:` body is substituted as SCRIPT TEXT before
# bash sees it, so a ref name containing $( ) or backticks executes. These are REUSABLE
# workflows: a consumer can trigger docs.yml on `push: branches: ['**']`, which hands
# the string to anyone who can push a branch. The rule is therefore absolute rather than
# case-by-case — every context value comes through `env:` — and this is what keeps it
# absolute. There is deliberately no allow-list; add one only with a comment saying why
# the value cannot be attacker-controlled.
print("\n-- every workflow: no ${{ }} inside a run: body --")
for name in sorted(os.listdir(WF)):
    if not name.endswith((".yml", ".yaml")):
        continue
    wf = load(name)
    for job_name, job in (wf.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            body = step.get("run")
            if not body or "${{" not in body:
                continue
            label = step.get("name", body.splitlines()[0][:40])
            check(f"{name}:{job_name}:{label!r} takes context through env:", False,
                  "\n         ".join(l.strip() for l in body.splitlines() if "${{" in l))
check("all run: bodies are expression-free", True)

# Two defaults that are wrong in the unsafe direction if left unset: the token is
# whatever the repo/org default is (potentially write-all), and a hung step burns the
# 6-hour job default. `timeout-minutes` is only settable on a job that has `steps` —
# a job that is just `uses:` a reusable workflow inherits the callee's.
print("\n-- every workflow: permissions + timeouts --")
for name in sorted(os.listdir(WF)):
    if not name.endswith((".yml", ".yaml")):
        continue
    wf = load(name)
    jobs = wf.get("jobs") or {}
    check(f"{name} declares permissions",
          "permissions" in wf or all("permissions" in j for j in jobs.values()),
          f"jobs without permissions: {[n for n, j in jobs.items() if 'permissions' not in j]}")
    for job_name, job in jobs.items():
        if not job.get("steps"):
            continue
        check(f"{name}:{job_name} is time-bounded", "timeout-minutes" in job)

print("\n-- entry: ci.yml --")
check("builds without publishing", "publish" not in ci["jobs"], list(ci["jobs"]))
check("uploads the docs artifact the engine gathers", "docs" in ci["jobs"], list(ci["jobs"]))

print("\n" + ("FAILURES: " + ", ".join(fails) if fails else "all shape checks passed"))
sys.exit(1 if fails else 0)
