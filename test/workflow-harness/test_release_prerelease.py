"""
Drift guard: release.yml's `--prerelease` test vs assemble.mjs's isPrerelease.

They are two implementations of one rule — bash in the consumer's repo (where nothing
of ours is checked out) and JS in the engine — and they HAVE drifted: the shell `case`
globs were case-sensitive while the regex carried /i, so `1.0.0RC1` was published as a
stable release but rendered as a prerelease. This runs a fixture list through both, the
bash half extracted from the workflow YAML so the test cannot go stale.
"""

import os, re, subprocess, sys

import yaml

H = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(H))

# Every spelling the two implementations must agree on: PEP 440, hyphenated semver,
# the case variants, and the near-misses that must stay STABLE.
TAGS = [
    "1.0.0", "2.1", "v1.2.3", "1.10.0",
    "1.0a1", "2.0rc1", "3.0b1", "1.0.0rc1", "1.0.0RC1", "1.0.0Rc1",
    "1.1.0-beta.1", "1.0.0-rc1", "v1.2.3-alpha", "2.0.0-pre.1", "1.0.dev0",
    "1.3.2-a9", "2.0.0-ALPHA", "1.0_b2", "1.0.0-preview.2",
    "release-1.0", "beta-program", "stable-2.0", "1.0-candidate", "2.0-canary",
    "1.0-preflight", "v2", "2026.03.1",
]

fails = []


def check(name, cond, detail=""):
    print(("  ok   - " if cond else "  FAIL - ") + name + (f"\n         {detail}" if not cond and detail else ""))
    if not cond:
        fails.append(name)


def bash_body():
    """release.yml's prerelease test, lifted out of the step it lives in."""
    d = yaml.safe_load(open(f"{REPO}/.github/workflows/release.yml"))
    step = next(s for s in d["jobs"]["release"]["steps"] if "Release with its assets" in s.get("name", ""))
    body = step["run"]
    # Everything up to the `gh release view` branch: the marker list and the test.
    return body.split("if gh release view")[0]


BASH = bash_body()

# One list in two files, so read both and compare the literals as well as the verdicts:
# equal behaviour on 27 fixtures would not stop someone adding a marker to only one.
wf_markers = re.search(r"markers='([^']*)'", BASH).group(1)
js_markers = re.search(r'const MARKERS = "([^"]*)"', open(f"{REPO}/assemble/assemble.mjs").read()).group(1)
check("release.yml carries assemble.mjs's MARKERS verbatim", wf_markers == js_markers,
      f"release.yml={wf_markers!r} assemble.mjs={js_markers!r}")

# The JS verdicts, one process for the whole list.
js = subprocess.run(
    ["node", "--input-type=module", "-e",
     f'import {{ isPrerelease }} from "{REPO}/assemble/assemble.mjs";'
     f'for (const t of process.argv.slice(1)) console.log(isPrerelease(t) ? "1" : "0");',
     "--", *TAGS],
    capture_output=True, text=True)
assert js.returncode == 0, js.stderr
js_verdicts = js.stdout.split()

for tag, want in zip(TAGS, js_verdicts):
    p = subprocess.run(["bash", "-c", BASH + '\nprintf "%s" "${prerelease:-}"'],
                       env={**os.environ, "TAG": tag}, capture_output=True, text=True)
    got = "1" if p.stdout.strip() == "--prerelease" else "0"
    check(f"{tag}: both say {'prerelease' if want == '1' else 'stable'}", got == want,
          f"release.yml={got} assemble.mjs={want} {p.stderr}")

print(f"\n{'FAILURES: ' + ', '.join(fails) if fails else 'all prerelease-parity checks passed'}")
sys.exit(1 if fails else 0)
