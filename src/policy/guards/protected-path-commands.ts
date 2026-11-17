/** Leading words that run the next word as a command (env assignments, sudo, shell keywords): skipped to find the real command word. */
const WRAPPER_RE = /^(?:sudo|env|command|time|nice|nohup|exec|builtin|\{|!|if|then|else|elif|do|while|until|\w+=\S*)$/;
/** Options of wrapper commands that take a separate value (`nice -n 10`, `env -u HOME`, `exec -a NAME`): the value is skipped with the option. */
const WRAPPER_VALUE_OPTS: Readonly<Record<string, readonly string[]>> = {
  nice: ["-n"], env: ["-u", "-C", "-S"], exec: ["-a"], time: ["-o", "-f"], sudo: ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U"],
};
/** Wrapper options after which NOTHING is executed (`command -v rm K`, `sudo -l`): the rest is only inspected, never run. */
const WRAPPER_NO_RUN: Readonly<Record<string, readonly string[]>> = { command: ["-v", "-V"], sudo: ["-l", "-v", "-V", "-k", "-K", "-h"] };
/** In-place flag spellings: sed `-i`/`-I`/`-iSUF`/`-Ei`/`--in-place`; perl bundles like `-pi`, `-wpi`, `-0pi`, `-i.bak` (never `-Mstrict`, `-I`, `-e`). */
const IN_PLACE: Readonly<Record<string, RegExp>> = { sed: /^(?:-[pnlaEsuzr]*[iI]\S*|--in-place\S*)$/, perl: /^-[pnlaEsuzrwW0-9]*i\S*$/ };
/** Commands whose every operand is created, truncated, deleted or moved away. */
const DESTRUCTIVE = new Set(["touch", "truncate", "rm", "rmdir", "unlink", "shred", "mv"]);
/** Short option letters that take a READ-ONLY value, per command (`touch -r REF`, `truncate -s N`; `rm` has none, so `rm -r DIR` keeps DIR). */
const VALUE_LETTERS: Readonly<Record<string, string>> = { touch: "rdt", truncate: "sr", shred: "ns" };
/** Long options that take a separate read-only value. */
const VALUE_LONG = new Set(["--reference", "--date", "--size", "--iterations", "--random-source", "--bytes"]);
/** `xargs` options that take a separate argument. */
const XARGS_ARG_OPTS = new Set(["-I", "-J", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "--max-args", "--max-procs"]);
/** `find` options that may precede the search roots. */
const FIND_PRE_OPTS = /^-[HLPxXEsd]+$/;

/** Receives one candidate write target. */
export type Push = (t: string | undefined) => void;

/** Operands (non-option words), without shell line-continuation / find terminators. */
const positional = (toks: string[]): string[] => toks.filter((t) => Boolean(t) && !t.startsWith("-") && t !== "\\" && t !== "+");

/** Value of option (`-t DIR`, `-tDIR`, `-rt DIR` bundle, `--long=DIR`, `--long DIR`), or undefined. */
function optionValue(toks: string[], short: string, long: string): string | undefined {
  const bundle = new RegExp(`^-[a-zA-Z]*${short.slice(1)}$`);
  const i = toks.findIndex((x) => x === short || x === long || x.startsWith(`${long}=`) || bundle.test(x) || (x.startsWith(short) && x.length > 2 && !x.startsWith("--")));
  const x = toks[i];
  if (i < 0 || x === undefined) return undefined;
  if (x === long || bundle.test(x)) return toks[i + 1];
  return x.startsWith(`${long}=`) ? x.slice(long.length + 1) : x.slice(short.length);
}

/** Operands of a {@link DESTRUCTIVE} command, skipping the read-only value of options like `touch -r REF` / `-cr REF` / `truncate -s 0`. */
function destructiveOperands(verb: string, toks: string[]): string[] {
  const letters = VALUE_LETTERS[verb] ?? "", out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i] ?? "";
    if (x === "--") { out.push(...positional(toks.slice(i + 1))); break; }
    if (x.startsWith("--")) { if (VALUE_LONG.has(x)) i++; continue; }
    if (x.startsWith("-") && x.length > 1) {
      const p = [...x.slice(1)].findIndex((c) => letters.includes(c));
      if (p >= 0 && p === x.length - 2) i++; // the value letter ends the bundle: its value is the next word (glued values need no skip)
      continue;
    }
    if (x) out.push(x);
  }
  return out;
}

/** Parse an in-place `sed`/`perl` command line: whether a REAL in-place flag is present (flag-shaped script words after `-e`/`-f` do not count) and its file operands (script words are not files). */
function inPlace(verb: string, toks: string[]): { on: boolean; files: string[] } {
  const re = IN_PLACE[verb];
  const rest: string[] = [];
  let on = false, scripted = false;
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i] ?? "";
    if (x === "-e" || x === "-f" || x === "--expression" || x === "--file") { scripted = true; i++; continue; }
    if (x.startsWith("--expression=") || x.startsWith("--file=")) { scripted = true; continue; }
    if (x.startsWith("-")) {
      // After the first FILE operand a flag-looking word is a file name (perl stops option parsing at the script; BSD sed at the first operand).
      const filesSeen = verb === "perl" ? rest.length > 0 : rest.length >= (scripted ? 1 : 2);
      if (filesSeen) { rest.push(x); continue; }
      if (re?.test(x)) on = true; else if (/^-[a-zA-Z]*[ef]\S+$/.test(x)) scripted = true;
      continue;
    }
    rest.push(x);
  }
  return { on, files: scripted ? rest : rest.slice(1) };
}

/** Whether `-x`/`x` (extract) is among a tar command line's option words (`tar xf`, `tar -xzf`, `--extract`). */
const tarExtracts = (toks: string[]): boolean => !toks.includes("--to-stdout") && toks.some((t, i) => t === "--extract" || t === "--get" || /^-[a-zA-Z]*x[a-zA-Z]*$/.test(t) || (i === 0 && /^[a-zA-Z]*x[a-zA-Z]*$/.test(t))) && !toks.some((t, i) => /O/.test(t) && (/^-[a-zA-Z]+$/.test(t) || (i === 0 && /^[a-zA-Z]+$/.test(t)))); // `-O` extracts to stdout: nothing is written

/** Verb of a command's words once wrappers and their options are skipped; `verb` is "" when the wrapper only inspects (`command -v`, `sudo -l`). */
function verbOf(rawToks: string[]): { verb: string; toks: string[] } {
  const toks = [...rawToks];
  while (toks.length && WRAPPER_RE.test(toks[0] ?? "")) {
    const w = toks.shift() ?? "";
    while (toks.length && (toks[0] ?? "").startsWith("-")) {
      const o = toks.shift() ?? "";
      if (WRAPPER_NO_RUN[w]?.includes(o)) return { verb: "", toks: [] };
      if (WRAPPER_VALUE_OPTS[w]?.includes(o)) toks.shift();
    }
  }
  return { verb: (toks.shift() ?? "").split("/").at(-1) ?? "", toks };
}

/** rsync destination: the last operand that is not the separate value of a `--long` option (`--exclude-from FILE`); needs 2+ operands overall. */
function rsyncDest(toks: string[]): string | undefined {
  const isValue = (i: number): boolean => (toks[i - 1] ?? "").startsWith("--") && !(toks[i - 1] ?? "").includes("="); // `--exclude -n`: -n is a value
  if (toks.some((t, i) => !isValue(i) && (t === "--dry-run" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t)))) return undefined; // a dry run (`-n`, `-an`, `--dry-run`) writes nothing
  const dests = toks.filter((t, i) => t && !t.startsWith("-") && !((toks[i - 1] ?? "").startsWith("--") && !(toks[i - 1] ?? "").includes("=")));
  return positional(toks).length >= 2 ? dests.at(-1) : undefined;
}

/** Search roots of a `find` command line: operands before the expression, after any leading `-H/-L/-P/-x/…` options (`-f PATH` too). */
function findRoots(toks: string[]): string[] {
  const roots: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] ?? "";
    if (FIND_PRE_OPTS.test(t)) continue;
    if (t === "-f") { roots.push(toks[++i] ?? ""); continue; }
    if (t.startsWith("-") || t === "(" || t === "!") break;
    roots.push(t);
  }
  return roots;
}

/**
 * Write targets of ONE simple command, given its words. Only operands that are really written count: destinations of
 * `cp`/`ln`/`install`/`rsync` (needs 2+ operands, or `-t DIR`), every operand of `mv`/`touch`/`truncate`/`rm`/…,
 * `tee` files, `dd of=`, `tar` extraction `-C`, `unzip -d`, in-place `sed`/`perl` files, and the command run by
 * `xargs` / `find -exec` (plus the `find` roots when `-delete` is given or the `-exec` command writes `{}`).
 * @param rawToks - The command's words (redirections already removed).
 * @param push - Receives each candidate target.
 */
export function commandTargets(rawToks: string[], push: Push): void {
  const { verb, toks } = verbOf(rawToks);
  const pos = positional(toks);
  if (verb === "tee") pos.forEach(push);
  else if (verb === "rsync") push(rsyncDest(toks)); // `-t` is "preserve times" for rsync, not a target directory
  else if (verb === "cp" || verb === "ln" || verb === "install") { const t = optionValue(toks, "-t", "--target-directory"); if (t !== undefined) push(t); else if (pos.length >= 2) push(pos.at(-1)); }
  else if (verb === "mv") { push(optionValue(toks, "-t", "--target-directory")); pos.forEach(push); } // sources are moved away, so they are written too
  else if (DESTRUCTIVE.has(verb)) destructiveOperands(verb, toks).forEach(push);
  else if (verb === "dd") toks.filter((x) => x.startsWith("of=")).forEach((x) => push(x.slice(3)));
  else if ((verb === "tar" || verb === "bsdtar") && tarExtracts(toks)) push(optionValue(toks, "-C", "--directory"));
  else if (verb === "unzip") { if (!toks.some((t) => /^-[a-zA-Z]*[ltpvzZ][a-zA-Z]*$/.test(t))) push(optionValue(toks, "-d", "--directory")); } // -l/-t/-p/-v/-z/-Z list, test or print: nothing is extracted
  else if (verb === "sed" || verb === "perl") { const p = inPlace(verb, toks); if (p.on) p.files.forEach(push); }
  else if (verb === "xargs") { // `… | xargs cp {} DIR`: the rest is the command
    let i = 0;
    for (; i < toks.length && (toks[i] ?? "").startsWith("-"); i++) if (XARGS_ARG_OPTS.has(toks[i] ?? "")) i++;
    commandTargets(toks.slice(i), push);
  } else if (verb === "find") {
    let writesFound = toks.includes("-delete");
    const isExec = (x: string | undefined): boolean => ["-exec", "-execdir", "-ok", "-okdir"].includes(x ?? "");
    for (let i = 0; i < toks.length; i++) { // every `-exec … ;|+` clause (a command may carry several; the stripper may have dropped the `\;`)
      if (!isExec(toks[i])) continue;
      let j = i + 1;
      while (j < toks.length && !["+", ";", "\\"].includes(toks[j] ?? "") && !isExec(toks[j])) j++;
      commandTargets(toks.slice(i + 1, j), (t) => { push(t); if (t !== undefined && /^\{\}[^/]*$/.test(t)) writesFound = true; }); // `{}` or a sibling name derived from it (`{}.bak`), never `~/bk/{}` (a copy OUT)
      i = j - 1;
    }
    if (writesFound) findRoots(toks).forEach(push);
  }
}
