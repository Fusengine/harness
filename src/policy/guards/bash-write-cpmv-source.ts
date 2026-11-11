import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CODE_NAME, GLOB, inProject, isDir, isTemp, outsideProven, type CpContext } from "./bash-write-cpmv-paths";
import { scanGlob, scanTree } from "./bash-write-cpmv-tree";
import type { WordTok } from "./bash-write-descend-types";

/** Everything {@link provablyBad} needs to know about the command around one source word. */
export interface SrcEnv {
  dst: WordTok;
  /** Absolute destination path (null when the directory relative paths resolve against is unknown). */
  dstAbs: string | null;
  dirDst: boolean;
  ctx: CpContext;
  /** Directory a relative source resolves against (the link's directory for `ln -s`); null = unknown. */
  linkDir: string | null;
  symlink: boolean;
  /** The copy follows links (`-L`, `-H`, `--deref…`). */
  deref: boolean;
  /** Directories are copied/moved with their contents (`mv`, `cp -r/-R/-a`); a plain `cp` skips them. */
  recursive: boolean;
  /** A symlink operand is moved/copied as a link, carrying no content (`mv`, `ln -s`, `cp -R/-P/-a`). */
  linkAsLink: boolean;
}

/** A glob whose last literal suffix is a non-code extension (`*.png`, `*.1`) can only match non-code names. */
const nonCodeGlob = (v: string): boolean => /\.[A-Za-z0-9]+$/.test(v) && !CODE_NAME.test(v);

/**
 * True only when this source PROVABLY lands foreign content in a project code file:
 * the destination is a literal, resolved code file (or a directory receiving a code file / a tree holding code)
 * inside the project, the source is literal and resolved (no `$`, backtick, `{}` placeholder, unknown cwd), and the
 * source is provably (i) under a temp/scratchpad dir, (ii) a non-code file, or (iii) outside a PROVEN project root
 * (a code file for a tree/glob match, read on disk within the bound). Everything else is "cannot tell" = false,
 * so the base verdict stands.
 * @param s - The source word.
 * @param e - The command around it.
 */
export function provablyBad(s: WordTok, e: SrcEnv): boolean {
  const v = s.value;
  if (s.dynamic || /[$`]/.test(v) || v.includes("{}") || e.dstAbs === null) return false;
  const brace = /\{[^{},]*(?:,[^{},]*)+\}/.exec(v);
  if (brace) return brace[0].slice(1, -1).split(",").some((alt) => provablyBad({ ...s, value: v.replace(brace[0], alt) }, e));
  if (v.includes("{") || (e.linkDir === null && !isAbsolute(v)) || !inProject(e.ctx, e.dstAbs)) return false;
  // Only an UNQUOTED leading `~` / `~/…` is the home directory (judged on the raw word: `~/"a b.ts"` still expands).
  // A quoted or escaped tilde is a literal directory, `~+`/`~-` are $PWD/$OLDPWD, `~user` is another home: cannot tell.
  if (v.startsWith("~") && s.raw !== "~" && !s.raw.startsWith("~/")) return false;
  const abs = resolve(e.linkDir ?? "/", v.replace(/^~(?=\/|$)/, homedir()));
  if (abs.startsWith("/dev/")) return false; // `cp /dev/null file`: a device, not file content
  const dstCode = CODE_NAME.test(e.dst.value);
  const foreign = (p: string): boolean => isTemp(e.ctx, p) || outsideProven(e.ctx, p);

  if (e.linkAsLink && !GLOB.test(v) && !/\/\.?$/.test(v)) { // (a trailing `/` or `/.` makes cp follow the link)
    try { if (lstatSync(abs).isSymbolicLink()) return false; } catch { /* missing: judged below */ }
  }
  if (GLOB.test(v)) {
    if (!e.dirDst) return dstCode && nonCodeGlob(v);
    if (nonCodeGlob(v) || inProject(e.ctx, dirname(abs)) || !foreign(dirname(abs))) return false;
    return scanGlob(abs, e.deref, { recursive: e.recursive, follow: e.deref || (e.recursive && !e.linkAsLink) }) === "code";
  }
  if (isDir(abs)) {
    if (e.symlink || (!e.dirDst && dstCode) || inProject(e.ctx, abs) || !foreign(abs)) return false;
    return scanTree(abs, e.deref) === "code";
  }
  const comp = basename(v);
  if (!CODE_NAME.test(e.dirDst ? join(e.dst.value, comp) : e.dst.value)) return false; // no code file lands
  if (!CODE_NAME.test(comp)) return true; // (ii) a non-code file becomes code
  return !inProject(e.ctx, abs) && foreign(abs); // (i) temp, (iii) outside a proven root
}
