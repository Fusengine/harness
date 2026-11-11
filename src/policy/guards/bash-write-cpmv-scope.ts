import { resolve } from "node:path";
import { isDir } from "./bash-write-cpmv-paths";
import { plain } from "./bash-write-descend-peel";
import type { Unit, WordTok } from "./bash-write-descend-types";

/** At most this many `cd` are followed; beyond it the directory is unknown (bounds path growth on adversarial input). */
const MAX_CD = 200;
const OPENERS = new Set(["{", "then", "do", "else", "elif"]);
const CLOSERS = new Set(["}", "fi", "done"]);
/** Commands whose success (or harmlessness) lets a following `&& cd` be trusted. */
const SURE_PREV = new Set(["mkdir", "cd", "true", "pwd", "ls", "echo", "git"]);

/**
 * Tracks the directory relative paths resolve against while commands are visited in source order.
 * A `cd DIR` is followed only when it certainly runs and certainly succeeds as far as text can tell:
 * a literal, existing directory, at nesting depth 0 (not in a `{ }`, `then`/`do` body, function or
 * `case` arm), directly after nothing, `;`, newline or `&&` (never after `||`, `|` or `&`). Any other
 * `cd`, and `pushd`/`popd`, make the directory unknown (null). A `( … )` subshell restores it on exit.
 */
export class CwdTracker {
  private stack: Array<string | null> = [];
  private caseAt: number[] = [];
  private depth = 0;
  private cds = 0;
  private prev = "";

  constructor(public from: string | null) {}

  /** Remember the name of the command just handled (the `&&` rule looks at it). */
  done(name: string): void { this.prev = name; }

  /** Update the nesting state for the command `u` (call before looking at the command itself). */
  enter(u: Unit): void {
    const head = plain(u.argv[0]);
    if (u.before === "(") this.stack.push(this.from);
    if (u.before === ")") {
      if (this.caseAt.length > 0 && this.stack.length === this.caseAt[this.caseAt.length - 1]) { /* case pattern `)` */ }
      else if (this.stack.length > 0) this.from = this.stack.pop() ?? null;
    }
    if (head === "case") this.caseAt.push(this.stack.length);
    if (head === "esac") this.caseAt.pop();
    if (OPENERS.has(head)) this.depth++;
    if (CLOSERS.has(head)) this.depth = Math.max(0, this.depth - 1);
  }

  /** Apply `cd`/`pushd`/`popd` (argv = peeled command words). Returns true when the command was one of them. */
  chdir(u: Unit, argv: readonly WordTok[], name: string, next?: Unit): boolean {
    if (name === "pushd" || name === "popd") { this.from = null; return true; }
    if (name !== "cd") return false;
    if (next && (next.before === "|" || next.before === "&")) return true; // piped / backgrounded: runs in a subshell, the cwd is unchanged
    const a = argv[1];
    // after `&&` the cd runs only if the previous command succeeded: trusted after commands that do (mkdir, cd, true, ...), not after `false`/`test`/unknown ones
    const reached = u.before === "&&" ? SURE_PREV.has(this.prev) : ["", ";", "\n", "("].includes(u.before);
    const sure = this.depth === 0 && this.caseAt.length === 0 && reached && this.cds++ < MAX_CD;
    const target = a && !a.dynamic && !a.value.startsWith("-") && !a.value.startsWith("~") && this.from !== null ? resolve(this.from, a.value) : null;
    this.from = sure && target !== null && isDir(target) ? target : null;
    return true;
  }
}
