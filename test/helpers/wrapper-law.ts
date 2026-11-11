import { evaluate } from "../../src/policy/evaluate";
import { releaseAction } from "../../src/policy/release-command";

/** Prompt kind of the stateless policy chain for a Bash `command` (`"allow"` when no prompt). */
export function kind(command: string): string {
  return evaluate({ tool: "Bash", command }).prompt?.kind ?? "allow";
}

/** Verdict rank: allow < ask < block. */
export type Rank = 0 | 2 | 3;

/** Verdict of the stateless policy chain plus the release classification (`gh pr merge` / tag = at least ask). */
export function rank(command: string): Rank {
  const prompt = evaluate({ tool: "Bash", command }).prompt;
  const base: Rank = prompt === undefined || prompt === null ? 0 : prompt.kind === "block" ? 3 : 2;
  return base === 0 && releaseAction(command) !== null ? 2 : base;
}

/** One bare command with the minimum verdict the owner's rules require (`spec`). */
export interface Atom { cmd: string; spec: Rank }

/** `git` atoms: `{G}` marks where git global options go. */
export const GIT_ATOMS: Atom[] = [
  { cmd: "git {G}push --force origin feat/x", spec: 3 },
  { cmd: "git {G}push -f origin feat/x", spec: 3 },
  { cmd: "git {G}push --force-with-lease origin feat/x", spec: 3 },
  { cmd: "git {G}reset --hard HEAD~1", spec: 3 },
  { cmd: "git {G}clean -fd", spec: 3 },
  { cmd: "git {G}branch -D feat/x", spec: 3 },
  { cmd: "git {G}push origin main", spec: 2 },
  { cmd: "git {G}push origin feat/x", spec: 2 },
  { cmd: "git {G}reset HEAD~1", spec: 2 },
  { cmd: "git {G}commit -m msg", spec: 2 },
  { cmd: "git {G}merge feat/x", spec: 2 },
  { cmd: "git {G}checkout main", spec: 2 },
  { cmd: "git {G}stash", spec: 2 },
];

/** `rm` / `unlink` / trash atoms (spec = verdict required of the bare AND every wrapped form). */
export const RM_ATOMS: Atom[] = [
  { cmd: "rm -rf ./build", spec: 2 },
  { cmd: "rm -r ./build", spec: 2 },
  { cmd: "rm ./a.txt", spec: 2 },
  { cmd: "unlink ./a.txt", spec: 2 },
  { cmd: "rm -rf /etc/x", spec: 3 },
  { cmd: "rm -rf ~", spec: 3 },
  { cmd: "rm -rf ./x # trash", spec: 2 },
  { cmd: "echo trash; rm -rf ./x", spec: 2 },
  { cmd: "rm -rf ./trash-me", spec: 2 },
];

/** `gh pr merge` atoms. `--merge` carries no new block (spec 0 = no requirement beyond not weakening). */
export const GH_ATOMS: Atom[] = [
  { cmd: "gh pr merge 5 --squash", spec: 3 },
  { cmd: "gh pr merge 5 -s", spec: 3 },
  { cmd: "gh pr merge 5 --rebase", spec: 3 },
  { cmd: "gh pr merge 5 --merge --delete-branch", spec: 0 },
];

/** Execution-preserving wrappers; `{C}` is the wrapped command. */
export const WRAPPERS: string[] = [
  "cd x && {C}", "FOO=1 {C}", "env FOO=1 {C}", "command {C}", "nohup {C}", "time {C}", "xargs -I@ {C}",
  "sh -c '{C}'", "bash -c '{C}'", "sh -c \"{C}\"", "bash -lc '{C}'", "sh -e -c '{C}'", "eval '{C}'", "eval {C}",
  "( {C} )", "(cd x && {C})", "{ {C}; }", "if true; then {C}; fi", "for i in 1; do {C}; done",
  "while true; do {C}; break; done", "f() { {C}; }; f", "echo go && {C}", "true || {C}", "{C} &", "{C} ; true",
  "$({C})", "`{C}`", "echo hi | sh -c '{C}'", "echo '{C}' | sh", "sh <<'EOF'\n{C}\nEOF", "cat <(echo) <({C})",
];

/** Git global-option variants (`{G}` replacement). */
export const GIT_OPTS: string[] = ["-C x ", "-c user.name=a ", "--git-dir=.git ", "--git-dir .git ", "--no-pager ", "-C x -c k=v ", "--work-tree=x ", "-P "];

/** Wrap `cmd` in `wrapper` (single-quote safe: inner single quotes are shell-escaped for `'…'` wrappers). */
export function wrap(wrapper: string, cmd: string): string {
  const inSingle = wrapper.includes("'{C}'");
  return wrapper.replace("{C}", inSingle ? cmd.replaceAll("'", "'\\''") : cmd);
}
