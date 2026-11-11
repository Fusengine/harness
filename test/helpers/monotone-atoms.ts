/**
 * Atoms for the Bash-write monotonicity law: single real writes onto the code file `src/x.ts`.
 * The effect oracle prepares each temp dir with {@link seedFiles}; every atom changes `src/x.ts`
 * (content or link status) when it really runs.
 */

/** One atom: a command line that really writes the code file `src/x.ts`. */
export interface Atom {
  id: string;
  /** Command text (may span several lines for heredoc atoms). */
  cmd: string;
  /** True when `cmd` has a heredoc / several lines (compound contexts then use newline layout). */
  multiline: boolean;
  /** Gap atoms (cp/mv/install/ln) are writes the guard allows by design on main (SAFE_PREFIXES). */
  gap?: boolean;
}

const JS_WRITE = `require("fs").writeFileSync("src/x.ts","pwned")`;

/** The 16 atoms the guard denies at depth 0. */
export const DENY_ATOMS: readonly Atom[] = [
  { id: "redirect", cmd: "echo pwned > src/x.ts", multiline: false },
  { id: "append", cmd: "echo pwned >> src/x.ts", multiline: false },
  { id: "printf", cmd: "printf pwned > src/x.ts", multiline: false },
  { id: "cat-heredoc", cmd: "cat > src/x.ts <<ATOM\npwned\nATOM", multiline: true },
  { id: "tee", cmd: "echo pwned | tee src/x.ts", multiline: false },
  { id: "tee-a", cmd: "echo pwned | tee -a src/x.ts", multiline: false },
  { id: "sed-i", cmd: "sed -i.bak s/orig/pwned/ src/x.ts", multiline: false },
  { id: "perl-pi", cmd: "perl -pi -e s/orig/pwned/ src/x.ts", multiline: false },
  { id: "perl-e", cmd: `perl -e 'open(F,">src/x.ts");print F "pwned";close F'`, multiline: false },
  { id: "patch", cmd: "patch src/x.ts p.diff", multiline: false },
  { id: "python-c", cmd: `python3 -c "open('src/x.ts','w').write('pwned')"`, multiline: false },
  { id: "python-heredoc", cmd: "python3 - <<ATOM\nopen('src/x.ts','w').write('pwned')\nATOM", multiline: true },
  { id: "bun-e", cmd: `bun -e '${JS_WRITE}'`, multiline: false },
  { id: "node-e", cmd: `node -e '${JS_WRITE}'`, multiline: false },
  { id: "dd", cmd: "dd if=s.txt of=src/x.ts status=none", multiline: false },
  { id: "ruby-e", cmd: `ruby -e "File.write('src/x.ts','pwned')"`, multiline: false },
];

/** cp / mv / install / ln onto a code file: allowed by SAFE_PREFIXES on main. */
export const GAP_ATOMS: readonly Atom[] = [
  { id: "cp", cmd: "cp s.txt ./src/x.ts", multiline: false, gap: true },
  { id: "mv", cmd: "mv s.txt ./src/x.ts", multiline: false, gap: true },
  { id: "install", cmd: "install -m 644 s.txt ./src/x.ts", multiline: false, gap: true },
  { id: "ln", cmd: "ln -sf s.txt ./src/x.ts", multiline: false, gap: true },
];

/**
 * cp/mv/install/ln code -> code inside the project: Edit-shaped writes whose content is itself a gated
 * code file. Design (decisions.md): allowed silently. Effect oracle applies (`src/a.ts` is seeded).
 */
export const ALLOW_ATOMS: readonly Atom[] = [
  { id: "mv-code", cmd: "mv src/a.ts src/x.ts", multiline: false, gap: true },
  { id: "cp-code", cmd: "cp src/a.ts src/x.ts", multiline: false, gap: true },
  { id: "git-mv-code", cmd: "git mv src/a.ts src/x.ts", multiline: false, gap: true },
  { id: "install-code", cmd: "install -m 644 src/a.ts src/x.ts", multiline: false, gap: true },
  { id: "ln-code", cmd: "ln -sf a.ts src/x.ts", multiline: false, gap: true },
];

/**
 * cp/mv/ln onto a code file whose SOURCE is outside the project, in a temp/scratchpad dir, has a
 * non-code extension, or is a symlink to a non-code file: denied like the literal-text gate. Law-only
 * (the oracle cannot seed paths outside its temp dir).
 */
export const EXTRA_DENY_ATOMS: readonly Atom[] = [
  { id: "cp-tmp", cmd: "cp /tmp/s.ts ./src/x.ts", multiline: false, gap: true },
  { id: "cp-outside", cmd: "cp ../../outside/s.ts src/x.ts", multiline: false, gap: true },
  { id: "mv-scratchpad", cmd: "mv /private/tmp/claude-501/p/scratchpad/s.ts src/x.ts", multiline: false, gap: true },
  { id: "cp-noext", cmd: "cp s src/x.ts", multiline: false, gap: true },
  { id: "cp-tmpext", cmd: "cp s.tmp src/x.ts", multiline: false, gap: true },
  { id: "ln-etc", cmd: "ln -sf /etc/hosts src/x.ts", multiline: false, gap: true },
  { id: "ln-noncode", cmd: "ln -s s.txt src/x.ts", multiline: false, gap: true },
  { id: "stage-then-rename", cmd: "echo pwned > y.txt && mv y.txt y.ts && mv y.ts src/x.ts", multiline: false, gap: true },
];

/** Non-code destinations: verdicts must stay exactly as on main (allow). */
export const NONCODE_DST_ATOMS: readonly Atom[] = [
  { id: "cp-txt-txt", cmd: "cp s.txt out.txt", multiline: false, gap: true },
  { id: "mv-txt-log", cmd: "mv s.txt out.log", multiline: false, gap: true },
  { id: "ln-txt", cmd: "ln -sf s.txt out.lnk", multiline: false, gap: true },
];

/**
 * Session-state access shapes (no write to `src/x.ts`; the effect oracle does not apply). The
 * guard blocks any command touching the harness session-state dir, but the SAFE_PREFIXES early
 * return (`cat `, `ls`, `head `, `grep `, `find `, ...) currently runs first and lets these through.
 */
export const SESSION_ATOMS: readonly Atom[] = [
  { id: "ss-cat", cmd: "cat ~/.fuse-harness/cache/sessions/abc.json", multiline: false },
  { id: "ss-cat-glob", cmd: "cat ~/.fuse-harness/cache/sessions/*", multiline: false },
  { id: "ss-ls", cmd: "ls ~/.fuse-harness/cache/sessions", multiline: false },
  { id: "ss-head", cmd: "head -c 200 ~/.fuse-harness/cache/sessions/abc.json", multiline: false },
  { id: "ss-grep", cmd: "grep -r token ~/.fuse-harness/cache/sessions", multiline: false },
  { id: "ss-find", cmd: "find ~/.fuse-harness/cache/sessions -type f", multiline: false },
];

/** Files the oracle seeds in every throwaway directory. */
export const seedFiles: Readonly<Record<string, string>> = {
  "src/x.ts": "orig\n",
  "src/a.ts": "aaa\n",
  "s.txt": "pwned\n",
  "p.diff": "--- src/x.ts\n+++ src/x.ts\n@@ -1 +1 @@\n-orig\n+pwned\n",
};
