/**
 * Base-vs-candidate verdict differential over the monotone corpus, on every host id, through the
 * REAL CLI (`bun <root>/src/cli/bin.ts hook <id>`, one process per command, isolated HOME/cwd).
 *
 *   bun test/bash-write-monotone/differential.ts run <repoRoot> <out.json>   (MONO_STRIDE=k samples depth 2/neutral)
 *   bun test/bash-write-monotone/differential.ts diff <base.json> <cand.json>
 *
 * `diff` prints, per host, unchanged / loosened / tightened and attributes every changed row to a
 * category; a row it cannot attribute is listed under UNATTRIBUTED (which blocks the branch).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW_ATOMS, DENY_ATOMS, EXTRA_DENY_ATOMS, GAP_ATOMS, NONCODE_DST_ATOMS, SESSION_ATOMS } from "../helpers/monotone-atoms";
import { execCases, neutralCases } from "../helpers/monotone-contexts";
import { safeGitInit } from "../helpers/monotone-git";
import { pool } from "../helpers/monotone-oracle";
import { HOSTS, type HostId } from "../helpers/monotone-verdict";

interface Item { cmd: string; tag: string }
type Table = Record<HostId, Record<string, string>>;

const SED = ["git log | sed -E 's/x/y/Ig'", "sed -n '/x/Ip' f.txt", "sed 's/a/b/I' f.txt && grep -i foo g.txt", "sed -i s/a/b/ src/x.ts", "sed --in-place s/a/b/ src/x.ts", "sed -Ei s/a/b/ src/x.ts", "sed -ni p src/x.ts", "sed -e s/a/b/ -i src/x.ts"];
/** cp/mv/install/ln rows that must keep the base verdict on every host (code -> code, non-code destinations, directories). */
/** Directory-tree sources from outside the project: clean trees must keep the base verdict; a tree holding a .ts is refused. */
const TREES = [
  "cp -r /usr/share/man docs/man", "cp -r ~/templates/foo ./", "cp -r ../other/assets public/", "cp -r ../../trees/assets public/",
  "cp -r ../../trees/assets docs/man", "mv ../../trees/assets docs/", "cp -r src/ backup/", "cp -r ../../trees/withcode public/",
  "cp -r ../../trees/withcode docs/x", "mv ../../trees/withcode docs/", "cp -r ../../trees/withcode/ vendor/",
  // content already inside the project: renames/copies of directories keep the base verdict
  "mv ../src ../src2", "cp -r ../src ../src.bak", "cp -a ../src ../src-old", "git mv ../src ../src2",
  // unresolved feeds into a directory ask
  "find . -name '*.ts' | xargs -I{} cp {} ../dist/", "ls ../src | xargs -I % cp -r ../src/% ../dist/",
];

const MUST_REMAIN = [
  "cp a.ts b.ts", "mv old.ts new.ts", "git mv old.ts new.ts", "cp -r src/ backup/", "cp file.ts /tmp/", "cp notes.md notes2.md",
  "mv a.md docs/", "install -m 755 build/x bin/x", "ln -s ../a.ts b.ts", "cp s.txt out.txt", "mv s.txt out.log", "ln -sf s.txt out.lnk",
  "cd .. && cp a.ts b.ts", "{ cp a.ts b.ts; }", "if true; then mv old.ts new.ts; fi", "cp -r src backup", "mv a.md docs/ && ls", "cp a.ts b.ts c.ts",
  "ls > /tmp/x", "ls > /tmp/x && cp /tmp/x notes.txt",
];
const PAIR = ["git diff > /tmp/fh-x.txt", "cat README.md > /tmp/fh-y", "cp /tmp/fh-x.txt src/x.ts", "mv /tmp/fh-y src/x.ts", "git diff > /tmp/fh-x.txt && cp /tmp/fh-x.txt src/x.ts"];

/** bw-dev's differential rows (the commands whose verdict changed between ddcf2d7 and the bw-fix commit). */
const BWDEV = [
  "echo x > notes.md", "echo x > fresh.md", "printf 'a\\n' >> MEMORY.md", "tee fresh.txt <<< hi", "cat > fresh.md <<EOF\nhi\nEOF",
  "echo hi >| fresh.md", "echo hi &> fresh.md", "echo x > /tmp/fh-diff-lit.txt", "echo x > data.json",
  "cd /private/tmp/fh-diff-x/proj && printf '%s\\n' '- [a](b.md) — c' >> MEMORY.md && tail -2 MEMORY.md",
  "git diff > /tmp/fh-diff-x.patch", "ls > /tmp/fh-diff-x.txt", "git status > /private/tmp/fh-diff-x.txt", "cat package.json > /tmp/fh-diff-y.txt",
];

/** Category (a): fully literal writes to a non-code ordinary file, plus non-literal contrasts. */
const LITERAL = [
  "echo hi > out.txt", "echo hi >> out.log", "echo hi >| out.txt", "echo hi &> out.txt", "printf 'a\\n' > notes.md",
  "cat > notes.md <<'EOF'\nliteral\nEOF", "cat > notes.md <<EOF\nliteral\nEOF", "tee out.txt <<< literal", "cat > n.md <<< 'lit'",
  "echo $HOME > out.txt", "echo `date` > out.txt", "echo $(date) > out.txt", "echo ~ > out.txt", "echo *.ts > out.txt", "echo {a,b} > out.txt",
  "cat > n.md <<EOF\n$HOME\nEOF", "echo hi > .env", "echo hi > ~/.bashrc",
];

/**
 * The corpus: `MONO_CORPUS=<file.json>` ([{cmd, tag}]) replaces it, so other branches can reuse the
 * tool with their own commands. Otherwise: each command tagged with its source set.
 */
export function corpus(k: number): Item[] {
  if (process.env.MONO_CORPUS) return JSON.parse(readFileSync(process.env.MONO_CORPUS, "utf8")) as Item[];
  // MONO_TAGS=trees,must-remain,pairing: keep only the commands whose tag starts with one of these
  const tags = (process.env.MONO_TAGS ?? "").split(",").filter(Boolean);
  const all = builtinCorpus(k);
  return tags.length === 0 ? all : all.filter((i) => tags.some((t) => i.tag.startsWith(t)));
}

/** The built-in corpus, each command tagged with its source set. */
function builtinCorpus(k: number): Item[] {
  const items: Item[] = [];
  const add = (tag: string, cmds: Iterable<string>): void => { for (const cmd of cmds) items.push({ cmd, tag }); };
  const stride = <T,>(xs: T[]): T[] => xs.filter((_, i) => i % k === 0);
  add("deny-atom/0", DENY_ATOMS.map((a) => a.cmd));
  add("deny-atom/1", stride(execCases(DENY_ATOMS, 1)).map((c) => c.cmd));
  add("deny-atom/2", stride(execCases(DENY_ATOMS, 2)).map((c) => c.cmd));
  add("cpmv/gap", [...GAP_ATOMS, ...EXTRA_DENY_ATOMS, ...ALLOW_ATOMS].map((a) => a.cmd));
  add("cpmv/gap/1", stride(execCases([...GAP_ATOMS, ...EXTRA_DENY_ATOMS, ...ALLOW_ATOMS], 1)).map((c) => c.cmd));
  add("noncode-dst", NONCODE_DST_ATOMS.map((a) => a.cmd));
  add("session/0", SESSION_ATOMS.map((a) => a.cmd));
  add("session/1", execCases(SESSION_ATOMS, 1).map((c) => c.cmd));
  add("sed", SED);
  add("pairing", PAIR);
  add("must-remain", MUST_REMAIN);
  add("trees", TREES);
  add("literal-text", LITERAL);
  add("bwdev", BWDEV);
  add("neutral", stride(neutralCases([...DENY_ATOMS, ...GAP_ATOMS, ...ALLOW_ATOMS])).map((c) => c.cmd));
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.cmd) ? false : (seen.add(i.cmd), true)));
}

async function decide(root: string, id: HostId, cmd: string, cwd: string, home: string): Promise<string> {
  const session_id = `diff-${id}-${randomUUID()}`;
  const payload = id === "cursor"
    ? { hook_event_name: "beforeShellExecution", session_id, command: cmd, cwd }
    : { hook_event_name: "PreToolUse", session_id, tool_use_id: randomUUID(), cwd, tool_name: "Bash", tool_input: { command: cmd } };
  const p = Bun.spawn(["bun", join(root, "src/cli/bin.ts"), "hook", id], { cwd, env: { PATH: process.env.PATH ?? "", HOME: home }, stdin: new Blob([JSON.stringify(payload)]), stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill(), 20_000);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(timer);
  if (!out.trim()) return "allow";
  try {
    const j = JSON.parse(out) as { permission?: string; hookSpecificOutput?: { permissionDecision?: string } };
    return id === "cursor" ? (j.permission ?? "allow") : (j.hookSpecificOutput?.permissionDecision ?? "allow");
  } catch { return "error"; }
}

const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };

type Attributor = (tag: string, cmd: string, dir: "loosened" | "tightened") => string | null;

/**
 * Pluggable attributor: `MONO_ATTRIBUTOR=<module>` default-exports an {@link Attributor}; its
 * non-null answer wins over the built-ins. Category (a) is attributed by calling bw-fix's classifier
 * (src/policy/guards/bash-write-literal.ts) from such a module, never by duplicating it here.
 * A `literal-text` row is UNATTRIBUTED unless a module claims it.
 */
const plug: Attributor | null = process.env.MONO_ATTRIBUTOR
  ? ((await import(process.env.MONO_ATTRIBUTOR)) as { default: Attributor }).default
  : null;

/** Attribute a changed row to a category (or null = unattributable). */
function attribute(tag: string, cmd: string, dir: "loosened" | "tightened"): string | null {
  const claimed = plug?.(tag, cmd, dir);
  if (claimed) return claimed;
  if (tag === "neutral" && dir === "tightened" && /\b(?:cp|mv|install|ln) /.test(cmd)) return "(b) cp/mv/install/ln source rule, on a neutralised form (dead branch / uncalled body: over-block, listed)";
  if (tag === "neutral") return dir === "tightened" ? "over-block (neutralised form)" : null;
  if (tag === "pairing") return /\b(?:cp|mv|install|ln)\b/.test(cmd) && dir === "tightened" ? "(b) cp/mv/install/ln source rule (pairing)" : "(c) temp-output allow + pairing";
  if (tag === "must-remain") return null;
  if (tag === "trees" && dir === "tightened" && /withcode/.test(cmd)) return "(b) directory tree holding a code file";
  if (tag === "trees" && dir === "tightened" && /xargs/.test(cmd)) return "(b) unresolved xargs feed into a project directory (ask)";
  if (tag === "trees") return null;
  if ((tag === "bwdev" || tag === "literal-text") && dir === "loosened" && />\s*(?:\/private)?\/tmp\//.test(cmd)) return "(c) command output to temp allowed";
  if (tag.startsWith("cpmv")) return dir === "tightened" && /\b(cp|mv|install|ln) /.test(cmd) ? "(b) cp/mv/install/ln source rule" : null;
  if (tag === "sed") return "closed hole: sed in-place forms / I-flag false block";
  if (tag.startsWith("session")) return dir === "tightened" ? "closed hole: session-state ordering" : null;
  if (tag === "deny-atom/1" || tag === "deny-atom/2") return dir === "tightened" ? "closed hole: wrapper descent" : null;
  return null;
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "run" && a && b) {
  const k = Number(process.env.MONO_STRIDE ?? "5");
  const all = corpus(k);
  const limit = Number(process.env.MONO_LIMIT ?? "0");
  const items = limit > 0 ? all.filter((_, i) => i % Math.ceil(all.length / limit) === 0) : all;
  // payload cwd: a git checkout's `sub/` dir, so the project root (git top-level) is its parent
  const proj = join(realpathSync(mkdtempSync(join(tmpdir(), "fh-diff-cwd-"))), "proj");
  const cwd = join(proj, "sub");
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  safeGitInit(proj);
  for (const f of ["a.ts", "src/a.ts", "sub/old.ts", "sub/a.ts", "file.ts"]) writeFileSync(join(proj, f), "x\n");
  // directory trees outside the project (../../trees from the payload cwd): one without code, one holding a .ts
  const trees = join(proj, "..", "trees");
  mkdirSync(join(trees, "assets"), { recursive: true });
  mkdirSync(join(trees, "withcode/sub"), { recursive: true });
  for (const f of ["assets/a.png", "assets/b.css-map", "withcode/sub/deep.ts", "withcode/notes.md"]) writeFileSync(join(trees, f), "x\n");
  const home = mkdtempSync(join(tmpdir(), "fh-diff-home-"));
  const table = Object.fromEntries(HOSTS.map((h) => [h, {}])) as Table;
  await pool(HOSTS.flatMap((h) => items.map((i) => ({ h, i }))), 3, async ({ h, i }) => { (table[h] as Record<string, string>)[i.cmd] = await decide(a, h, i.cmd, cwd, home); });
  writeFileSync(b, JSON.stringify({ items, table }));
  console.log(`ran ${items.length} commands x ${HOSTS.length} hosts`);
} else if (mode === "diff" && a && b) {
  const base = JSON.parse(readFileSync(a, "utf8")) as { items: Item[]; table: Table };
  const cand = JSON.parse(readFileSync(b, "utf8")) as { items: Item[]; table: Table };
  for (const h of HOSTS) {
    const cats = new Map<string, { n: number; ex: string }>();
    let same = 0, loose = 0, tight = 0;
    for (const { cmd, tag } of cand.items) {
      const x = base.table[h][cmd] ?? "?", y = cand.table[h][cmd] ?? "?";
      if (x === y) { same++; continue; }
      const dir = (RANK[y] ?? 0) > (RANK[x] ?? 0) ? "tightened" : "loosened";
      if (dir === "tightened") tight++; else loose++;
      const claimed = attribute(tag, cmd, dir);
      // MONO_ALLOW=(b),(c): only these category prefixes may change; any other change is UNATTRIBUTED.
      const allowed = (process.env.MONO_ALLOW ?? "").split(",").filter(Boolean);
      const ok = claimed !== null && (allowed.length === 0 || allowed.some((p) => claimed.startsWith(p)));
      const cat = `${dir}: ${ok ? claimed : "UNATTRIBUTED"}`;
      const e = cats.get(cat) ?? { n: 0, ex: `${x}->${y} ${JSON.stringify(cmd)}` };
      e.n++; cats.set(cat, e);
    }
    console.log(`\n== ${h}: unchanged ${same} / loosened ${loose} / tightened ${tight}`);
    for (const [c, e] of [...cats].sort()) console.log(`  ${c}: ${e.n}  e.g. ${e.ex}`);
  }
}
