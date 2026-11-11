import { dirname, resolve } from "node:path";
import type { Prompt } from "../../prompt/types";
import { installDirsOnly, parseCpArgs } from "./bash-write-cpmv-args";
import { destContext, GLOB, isDir, provenRoot, realish, type CpContext } from "./bash-write-cpmv-paths";
import { CwdTracker } from "./bash-write-cpmv-scope";
import { provablyBad, type SrcEnv } from "./bash-write-cpmv-source";
import { base, peel, plain } from "./bash-write-descend-peel";
import { scan } from "./bash-write-descend-scan";
import type { WordTok } from "./bash-write-descend-types";
import { blockCodeWrite } from "./bash-write-prompts";

/** `git mv` words after the subcommand, with `-c k=v` skipped and `-C dir` applied to `from`. */
function gitMv(argv: readonly WordTok[], from: string | null): { args: WordTok[]; from: string | null } | null {
  let k = 1;
  let at = from;
  while (k < argv.length && plain(argv[k]).startsWith("-")) {
    const flag = plain(argv[k]);
    if (flag === "-C") { const d = argv[k + 1]; at = d && !d.dynamic && at !== null && !d.value.startsWith("~") ? resolve(at, d.value) : null; k++; }
    else if (flag === "-c") k++;
    k++;
  }
  return plain(argv[k]) === "mv" ? { args: argv.slice(k + 1) as WordTok[], from: at } : null;
}

/**
 * Proof of one cp / mv / install / ln (or `git mv`) writing foreign content into a project code file.
 * Returns a block prompt ONLY when {@link provablyBad} holds for a source; every uncertainty (variables, unknown
 * cwd, unresolved or unreadable trees, no proven root, placeholders) returns null so the base verdict stands.
 * This layer can only tighten: it never asks and never replaces a verdict.
 * @param argv - Peeled argv of one command.
 * @param ctx - Resolution context.
 */
function cpMoveProof(argv: readonly WordTok[], ctx: CpContext): Prompt | null {
  let verb = base(argv[0]);
  let args = argv.slice(1);
  let from = ctx.from;
  if (verb === "git") {
    const mv = gitMv(argv, from);
    if (!mv) return null;
    verb = "mv";
    args = mv.args;
    from = mv.from;
  }
  if (!["cp", "mv", "install", "ln"].includes(verb)) return null;
  if (verb === "install" && installDirsOnly(args)) return null; // `install -d` only makes directories
  const parsed = parseCpArgs(args);
  if (!parsed) return null;
  const { operands, targetDir } = parsed;
  const dst = targetDir ?? operands[operands.length - 1];
  const srcs = targetDir ? operands : operands.slice(0, -1);
  // (a `~` destination is the user's home, outside the project: nothing to prove)
  if (!dst || dst.dynamic || /[$`]/.test(dst.value) || GLOB.test(dst.value) || dst.value.includes("{") || dst.value.startsWith("~") || srcs.length === 0) return null;
  const symlink = verb === "ln" && args.some((a) => /^-[a-zA-Z]*s/.test(plain(a)) || plain(a) === "--symbolic");
  const dstAbs = from === null ? null : resolve(from, dst.value);
  const dirDst = !!targetDir || dst.value.endsWith("/") || (dstAbs !== null && isDir(dstAbs));
  const flags = args.map((a) => plain(a));
  const deref = flags.some((w) => /^-[A-Za-z]*[LH]/.test(w) || (w.length >= 4 && "--dereference".startsWith(w)));
  // verified on macOS: `mv`, `ln -s`, `cp -R/-P/-a` carry a link operand as a link; `cp -r`, plain `ln` (hard link), `install` follow it
  const keepsLinks = verb === "mv" || symlink || (verb === "cp" && flags.some((w) => /^-[A-Za-z]*[PRad]/.test(w) || w === "--no-dereference"));
  const env: SrcEnv = {
    dst, dstAbs, dirDst, ctx: { ...destContext(ctx, dstAbs), from }, symlink, deref,
    recursive: verb === "mv" || flags.some((w) => /^-[A-Za-z]*[rRa]/.test(w) || w === "--recursive"),
    linkAsLink: keepsLinks && !deref,
    linkDir: symlink && dstAbs !== null ? (dirDst ? dstAbs : dirname(dstAbs)) : from,
  };
  const bad = srcs.find((s) => provablyBad(s, env));
  return bad ? blockCodeWrite(`${verb} onto a project code file from a source that is not a code file inside the project (${bad.value}) — Use Write/Edit tools instead`) : null;
}

/** Words of `argv` that contain an xargs replace string (`-I R`, `-IR`, `-iR`, `-J R`, `--replace=R`) become unresolved placeholders. */
function markReplace(lead: readonly WordTok[], argv: readonly WordTok[]): WordTok[] {
  const repl = new Set<string>();
  lead.forEach((w, k) => {
    const v = plain(w);
    if ((v === "-I" || v === "-J") && lead[k + 1]) repl.add(plain(lead[k + 1]));
    else if (/^-[IiJ]./.test(v)) repl.add(v.slice(2));
    else if (v.startsWith("--replace=")) repl.add(v.slice(10));
  });
  repl.delete("");
  return argv.map((w) => ([...repl].some((r) => w.value.includes(r)) ? { ...w, value: "{}", dynamic: true } : w));
}

/**
 * Finds every cp/mv/install/ln (and `git mv`) in `cmd` — lists, compound bodies, subshells, env/timeout/xargs
 * prefixes — and returns the first PROVEN foreign-content write into a project code file as a block prompt.
 * Each destination is judged against its own proven root ({@link destContext}), not the payload cwd's.
 * Relative paths resolve against the payload cwd moved only by a `cd` that certainly runs ({@link CwdTracker});
 * `env -C`/`sudo -D`, `pushd`/`popd` and any other `cd` make it unknown, which yields no proof. Never asks.
 * @param cmd - Raw command text.
 * @param cwd - Payload cwd (undefined: nothing can be proven for relative destinations).
 * @param scratchpadDir - The session scratchpad (counts as a temp source).
 * @returns A block prompt, or null.
 */
export function cpMoveCommands(cmd: string, cwd: string | undefined, scratchpadDir?: string): Prompt | null {
  if (!/(?:cp|mv|install|ln)/.test(cmd.replace(/["'\\]/g, ""))) return null;
  try {
    const here = cwd ? realish(cwd) : null;
    let cached: string | null | undefined;
    const ctx: CpContext = { from: null, cwd: here, root: () => (cached === undefined ? (cached = provenRoot(here)) : cached), scratch: scratchpadDir, roots: new Map() };
    const track = new CwdTracker(here);
    const units = scan(cmd);
    for (const [n, u] of units.entries()) {
      track.enter(u);
      const argv = peel(u.argv);
      if (argv.length === 0) continue;
      const lead = u.argv.slice(0, u.argv.length - argv.length);
      const name = base(argv[0]);
      const isCd = track.chdir(u, argv, name, units[n + 1]);
      track.done(name);
      if (isCd) continue;
      const chdir = lead.some((w) => /^(?:-C|-D|--chdir(?:=.*)?)$/.test(plain(w)));
      const v = cpMoveProof(markReplace(lead, argv), { ...ctx, from: chdir ? null : track.from });
      if (v) return v;
    }
  } catch { /* an unreadable command keeps its other verdicts */ }
  return null;
}
