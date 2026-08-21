"""
Harness for the bash inside publish.yml's `deploy` job.

The gather steps are the workflow's most intricate logic — release selection,
an asset cache, a SHA-indexed artifact lookup, parallel downloads, and four
distinct failure modes — and they used to be testable only by merging and
watching a real deploy. This loads the steps straight out of the YAML (so the
tests cannot drift from the workflow), substitutes the ${{ }} expressions, and
runs them against a mock `gh` and synthetic release/artifact payloads.

Run with `npm run test:workflows`.
"""
import yaml, re, subprocess, os, sys, json, shutil, pathlib
H = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(os.path.dirname(H))
d = yaml.safe_load(open(f"{REPO_DIR}/.github/workflows/publish.yml"))
steps = {s.get("name"): s for s in d["jobs"]["deploy"]["steps"] if s.get("run")}

WANT = ["Select releases to publish", "Gather release artifacts", "Gather branch CI artifacts"]

def run(step_name, env, exprs):
    script = steps[step_name]["run"]
    script = re.sub(r"\$\{\{\s*([^}]*?)\s*\}\}", lambda m: exprs.get(m.group(1), ""), script)
    # step-level env: from the step's own `env:` block, after expression substitution
    senv = dict(env)
    for k, v in (steps[step_name].get("env") or {}).items():
        senv[k] = re.sub(r"\$\{\{\s*([^}]*?)\s*\}\}", lambda m: exprs.get(m.group(1), ""), str(v))
    p = subprocess.run(["bash", "-c", script], env=senv, capture_output=True, text=True)
    return p

def setup(tmp, releases, artifacts, prs, *, approved=(), dlfail=(), artfail=(), artnodocs=()):
    data = os.path.join(tmp, "data")
    os.makedirs(data, exist_ok=True)
    json.dump(releases, open(f"{data}/releases.json", "w"))
    # the real API wraps each page: {"total_count": N, "artifacts": [...]}
    json.dump({"total_count": len(artifacts), "artifacts": artifacts}, open(f"{data}/artifacts.json", "w"))
    open(f"{data}/prs.tsv", "w").write("".join(f"{n}\t{s}\t{str(c).lower()}\n" for n, s, c in prs))
    for name, vals in [("approved", approved), ("download-fails", dlfail),
                       ("artifact-fails", artfail), ("artifact-nodocs", artnodocs)]:
        open(f"{data}/{name}", "w").write("".join(f"{v}\n" for v in vals))
    for f in ("mkzip.sh", "mkartifact.sh"):
        shutil.copy(f"{H}/{f}", f"{data}/{f}"); os.chmod(f"{data}/{f}", 0o755)
    ws = os.path.join(tmp, "ws"); os.makedirs(ws, exist_ok=True)
    # COPY, don't symlink: assemble.mjs's `import.meta.url === file://argv[1]` main-guard
    # compares a resolved path against an unresolved one, so a symlinked checkout would
    # silently never run main(). CI does a real sparse-checkout, so this mirrors it.
    mvs = os.path.join(ws, ".mvs", "assemble")
    if os.path.exists(mvs): shutil.rmtree(mvs)
    shutil.copytree(f"{REPO_DIR}/assemble", mvs)
    rt = os.path.join(tmp, "runner"); os.makedirs(f"{rt}/gather", exist_ok=True); os.makedirs(f"{rt}/site", exist_ok=True)
    env = dict(os.environ)
    env.update({
        "PATH": f"{H}/bin:" + os.environ["PATH"],
        "MOCK_DATA": data, "MOCK_CALLS": os.path.join(tmp, "calls.log"),
        "RUNNER_TEMP": rt, "GITHUB_WORKSPACE": ws,
        "GITHUB_OUTPUT": os.path.join(tmp, "out.txt"),
        "GITHUB_SERVER_URL": "https://github.com",
        "REPO": "acme/widget", "DEFAULT": "main",
        "SEED_TAG": "pages-default-seed", "SOURCES_DIR": "_sources",
    })
    open(env["GITHUB_OUTPUT"], "w").close()
    open(env["MOCK_CALLS"], "w").close()
    return env, rt, data
