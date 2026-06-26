/**
 * inject-latest-tag — a build-only MyST transform for *this repo's own docs*.
 *
 * The tutorial's copy-paste snippets pin this project at a release tag. Rather
 * than hard-coding (and forever bumping) a version, the source carries the
 * sentinel `__LATEST_TAG__` and this transform swaps it for the repo's latest
 * tag at build time, so a reader copying the blocks gets a real, current ref.
 *
 * Unlike `plugins/version-switcher.mjs` (which is isomorphic — it also runs in
 * the browser), this file only ever runs under MyST (Node) at build time, so it
 * is free to touch git. It is loaded from `docs/myst.yml`, not shipped.
 *
 * The tag is taken from `LATEST_TAG` (set by the `docs`/`docs-dev` npm scripts,
 * which also handle fetching tags in a shallow CI checkout); if that is unset we
 * fall back to `git describe` directly (the bare `myst build` case). When no tag
 * can be resolved the sentinel is left in place and a warning is emitted, so a
 * missing tag is loud rather than silently shipping `__LATEST_TAG__` to readers.
 */
import { execSync } from "node:child_process";

const SENTINEL = "__LATEST_TAG__";

/** The latest release tag: `LATEST_TAG` env, else `git describe`, else null. */
function resolveLatestTag() {
	const fromEnv = process.env.LATEST_TAG?.trim();
	if (fromEnv) return fromEnv;
	try {
		// No fetch here — the npm scripts own that. This just reads what's local.
		return execSync("git describe --tags --abbrev=0", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/** Replace the sentinel in every string `value` in the tree (text + code nodes). */
function replaceInTree(node, tag) {
	if (!node || typeof node !== "object") return;
	if (typeof node.value === "string" && node.value.includes(SENTINEL)) {
		node.value = node.value.split(SENTINEL).join(tag);
	}
	if (Array.isArray(node.children)) {
		for (const child of node.children) replaceInTree(child, tag);
	}
}

const injectLatestTag = {
	name: "inject-latest-tag",
	doc: "Replace __LATEST_TAG__ with this repo's latest git tag at build time.",
	stage: "document",
	plugin: () => (tree, vfile) => {
		const tag = resolveLatestTag();
		if (!tag) {
			vfile?.message?.(
				`inject-latest-tag: no tag resolved (set LATEST_TAG or fetch git tags); leaving ${SENTINEL} as-is.`,
			);
			return;
		}
		replaceInTree(tree, tag);
	},
};

const plugin = {
	name: "inject-latest-tag",
	transforms: [injectLatestTag],
};

export default plugin;
