"""Synthetic release/artifact/PR payloads shared by the harness tests."""

def rel(tag, created, asset_id=None, size=100):
    a = [] if asset_id is None else [{"name": "docs.zip", "id": asset_id, "size": size}]
    return {"tag_name": tag, "created_at": created, "published_at": created, "assets": a}

def art(aid, sha, created, branch=None, repo_id=12345, run_id=999):
    return {"id": aid, "expired": False, "created_at": created, "size_in_bytes": 4096,
            "workflow_run": {"id": run_id, "head_sha": sha, "head_branch": branch,
                             "head_repository_id": repo_id}}

RELEASES = [
    rel("3.0", "2026-03-01T00:00:00Z", 301),
    rel("2.0", "2026-02-01T00:00:00Z", 201),
    rel("1.0", "2026-01-01T00:00:00Z", 101),
    rel("release/x", "2026-04-01T00:00:00Z", 401),      # '/' tag -> skip
    rel("0.9", "2025-12-01T00:00:00Z", None),           # no docs.zip -> skip
    rel("pages-default-seed", "2020-01-01T00:00:00Z", 1),
]
ARTIFACTS = [
    art(9001, "mainsha", "2026-05-01T00:00:00Z", branch="main"),
    art(9000, "mainsha", "2026-04-01T00:00:00Z", branch="main"),   # older, must lose
    art(9002, "forkbranch", "2026-05-01T00:00:00Z", branch="main", repo_id=777),  # fork, must lose
    art(9100, "pr7sha", "2026-05-02T00:00:00Z"),
    art(9200, "pr8sha", "2026-05-02T00:00:00Z"),
]
PRS = [(7, "pr7sha", False), (8, "pr8sha", True), (9, "pr9sha", False)]

def do(tmp, maxrel="0", **kw):
    env, rt, data = setup(tmp, RELEASES, ARTIFACTS, PRS, **kw)
    exprs = {"github.token": "t", "inputs.max-releases": maxrel, "runner.temp": rt}
    r1 = run("Select releases to publish", env, exprs)
    assert r1.returncode == 0, r1.stderr
    r2 = run("Gather release artifacts", env, exprs)
    r3 = run("Gather branch CI artifacts", env, exprs)
    return env, rt, data, r1, r2, r3

