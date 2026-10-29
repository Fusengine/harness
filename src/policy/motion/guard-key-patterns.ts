/** @module motion/guard-key-patterns Textual rules for names that can resolve into the Motion signing-key directory. */
import { LEGACY_MOTION_FRAGMENT, MOTION_KEY_FRAGMENT } from "./store";

/** Every prefix of `text` including the empty one, as a regex alternation (`v(?:i...)?` shape without nesting). */
function prefixes(text: string): string {
  return Array.from({ length: text.length + 1 }, (_, n) => text.slice(0, n).replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&")).join("|");
}

const ROOT = "video-motion";
const KEYS = "keys";
/** The glob reaches the Motion root's `keys` child: `video-motion/*`, `video-motion/k?`, a bare `video-motion/` at the end. */
const KEYS_GLOB = new RegExp(`${ROOT}\\/(?:(?:${prefixes(KEYS)})[*?\\[]|$)`, "i");
/** A glob next to the Motion root name (`video-motion*`, `video-motion?`). */
const ROOT_SIBLING_GLOB = new RegExp(`${ROOT}[*?\\[]`, "i");
/** A glob directly under the harness dir that can still select `video-motion` (`.fuse-harness/*`, `/v*`, `/[v]*`). */
const HARNESS_CHILD_GLOB = new RegExp(`\\.fuse-harness\\/(?:${prefixes(ROOT)}|${prefixes("motion-keys")})[*?\\[]`, "i");
/** A glob or variable inside the harness directory name itself (`.fuse-har*`, `.fuse-harness$X`). */
const HARNESS_NAME_GLOB = /\.fuse-har[A-Za-z-]*[*?[$]/;
/** Leftover pre-relocation key directory and its sibling glob, still protected for literal paths. */
const LEGACY_KEYS = `${LEGACY_MOTION_FRAGMENT}-keys`;
const LEGACY_GLOB = new RegExp(`\\.fuse-harness\\/motion[*?\\[]`);

/**
 * Textual test of one name (path, token, tool field or whole command line).
 * Same rules as before the relocation, retargeted from `.fuse-harness/motion-keys` to `video-motion/keys`.
 */
export function namesMotionKeys(name: string): boolean {
  if (name.includes(MOTION_KEY_FRAGMENT) || name.includes(LEGACY_KEYS) || LEGACY_GLOB.test(name) || KEYS_PATH.test(name)) return true;
  if (KEYS_GLOB.test(name) || ROOT_SIBLING_GLOB.test(name) || HARNESS_CHILD_GLOB.test(name) || HARNESS_NAME_GLOB.test(name)) return true;
  if (/[$*?[]/.test(name) && /video-mo/i.test(name)) return true;
  return /\.fuse-har/.test(name) && name.split(/[\s;|&<>()]+/).some(offGroundWord);
}

/** `video-motion/keys` named without its `.fuse-harness/` prefix (reached through `..`, a variable or a cwd). */
const KEYS_PATH = new RegExp(`${ROOT}[^\\s/]*\\/${KEYS}`, "i");
/** After the harness dir: `..`, a glob that can match `..`, ANSI-C / brace / substitution constructs that can hide a component. */
const HARNESS_TRICK = /\.fuse-har[^\s;|&<>()]*(?:\.\.|\/\.[*?[]|\$['"{(]|`)/;
/** A first path component that can still select `video-motion`: a bare glob, or a prefix of the name followed by a glob. */
const ROOT_PREFIX_GLOB = new RegExp(`^(?:${prefixes(ROOT)})[*?\\[]`, "i");

/**
 * In a line that names the harness dir, a word that does not name it can still reach the Motion root through a
 * cwd that moved there or a variable holding the harness root (`cd ~/.fuse-harness/cache; cat ../v*\/k*\/x`, `$X/v*\/k*`).
 */
function offGroundWord(word: string): boolean {
  if (HARNESS_TRICK.test(word)) return true;
  if (/\.fuse-har/.test(word)) return false;
  const bare = word.replace(/['"\\]/g, "").replace(/^(?:\.{1,2}\/)+/, "");
  if (ROOT_PREFIX_GLOB.test(bare)) return true;
  return /\$/.test(bare) && bare.includes("/") && /[*?[]/.test(bare);
}
