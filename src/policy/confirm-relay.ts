/**
 * @module confirm-relay
 * Core-scope refusal of an agent relaying a `CONFIRM <code>` into a nested agent
 * CLI (`codex exec resume --last 'CONFIRM ab12'`): the code arms an rm/git ask on
 * Codex/Kimi/Cursor and only the owner may type it in their own session. The
 * motion scope has its own looser check (`motion/forgery.ts`, Claude Code only);
 * this one runs on the core path every host wires, so it is deliberately narrow:
 * it reads an agent CLI the line REALLY RUNS (`expand`, through `sh -c`, `env`,
 * `xargs`, substitutions) and only the phrase the receiver accepts (the Kimi/Cursor
 * submit regex is unanchored: `CONFIRM ab12 now` arms), never a command that merely
 * mentions confirm/codex (commit message, grep, test runner).
 */
import { basename } from "node:path";
import type { Prompt } from "../prompt/types";
import { expand } from "./effective-segments";
import { expansionText } from "./motion/shell-verbs";
import { AGENT_CLI_VERBS } from "./motion/forgery";

/** The phrase the receiver arms on (`handleConfirmSubmit`): no leading boundary, any whitespace, trailing text allowed. */
const RELAY_PHRASE = /confirm[\s_-]*[0-9a-f]{4}\b/i;
/** `confirm` glued to the start of a code that is built at run time (`CONFIRM $(echo ab12)`, `CONFIRM ab1$(:)2`, `CONFIRM \x61b12`, an xargs `{}` / `%` placeholder). */
const BUILT_CODE = /confirm[\s_-]*[0-9a-f]{0,3}(?:\$|`|\\[xu0-7]|\{\}|%)/i;
/** `confirm` followed by a printf conversion, only meaningful inside an expansion (`$(printf 'CONFIRM %s' ab12)`). */
const PRINTF_CODE = /confirm[\s_-]*%[sdb]/i;

/** Package runners / interpreters that start an agent CLI named in their first arguments (`npx codex exec …`, `uv tool run kimi-cli …`, `node …/codex.js`). */
const LAUNCHERS: ReadonlySet<string> = new Set(["npx", "bunx", "pnpm", "yarn", "npm", "uvx", "uv", "pipx", "bun", "node"]);
/** Package names the agent CLIs ship under, besides their bin names. */
const PACKAGE_NAMES: ReadonlySet<string> = new Set(["claude-code", "kimi-cli"]);
/** Programs whose whole purpose here is to type or spawn text into another session. */
const TYPERS: ReadonlySet<string> = new Set(["osascript", "expect"]);
/** Terminal multiplexers / emulators: only their send-text subcommand types into a session. */
const TYPER_ARGS: Readonly<Record<string, readonly string[]>> = {
  tmux: ["send-keys", "send"], screen: ["stuff"], zellij: ["write-chars", "write"], wezterm: ["send-text"], kitty: ["send-text"], kitten: ["send-text"],
};
/** Cheap pre-filter: an agent CLI name or a typer must appear (quotes and escapes dropped) before the wrapper-aware walk runs. */
const MAY_RELAY = /claude|codex|cursor-agent|gemini|kimi|tmux|screen|zellij|wezterm|kitty|kitten|osascript|expect/i;

/** True when a word names an agent CLI: bin, package (`@openai/codex@1.2`, `kimi-cli`) or script (`…/codex.js`). */
function namesAgent(word: string): boolean {
  const name = basename(word).replace(/@[^@]*$/, "").replace(/\.[cm]?js$/, "");
  return AGENT_CLI_VERBS.has(name) || PACKAGE_NAMES.has(name);
}

/** True when the command word is an agent CLI, a runner naming one, a send-text subcommand, or a typer. */
function runsAgent(verb: string, argv: readonly string[]): boolean {
  return AGENT_CLI_VERBS.has(verb) || TYPERS.has(verb)
    || (TYPER_ARGS[verb]?.some((t) => argv.includes(t)) ?? false)
    // An interpreter runs a script given first (`node …/codex.js`, `bun run codex.js`); later words are the script's own arguments (`bun run x.ts hook codex`).
    || (LAUNCHERS.has(verb) && argv.slice(0, verb === "node" || verb === "bun" ? 2 : 6).some(namesAgent));
}

/** True when `text` carries a typed CONFIRM code, literal or built by expansion. */
function carriesCode(text: string, expanded: boolean): boolean {
  const plain = expansionText(text);
  // A phrase wrapped in escaped quotes (`osascript … \"CONFIRM ab12\"`): read it with the backslashes dropped too.
  const bare = text.replace(/\\/g, "");
  return RELAY_PHRASE.test(text) || RELAY_PHRASE.test(plain) || RELAY_PHRASE.test(bare) || BUILT_CODE.test(text) || BUILT_CODE.test(plain)
    || (expanded && (PRINTF_CODE.test(text) || PRINTF_CODE.test(plain)));
}

/** The text the agent segment can receive: its own pipeline (split on `;`, `&&`, `||`, and a newline unless a heredoc is present), else the whole line. */
function receivedText(command: string, seg: string): string {
  const parts = command.split(command.includes("<<") ? /&&|\|\||;/ : /&&|\|\||;|\n/);
  return parts.find((p) => p.includes(seg)) ?? command;
}

/**
 * Block prompt when a Bash command relays a CONFIRM code through an agent CLI it runs.
 * The phrase is read in the agent's own pipeline; when its segment holds a variable or substitution the whole line is read.
 * @param tool - Tool name.
 * @param command - `tool_input.command` (Bash).
 * @returns A block prompt, or `null` when no agent CLI carries a CONFIRM code.
 */
export function confirmRelayViolation(tool: string, command: string | undefined): Prompt | null {
  if (tool !== "Bash" || !command) return null;
  const plain = expansionText(command);
  if (!/confirm/i.test(plain) || !(MAY_RELAY.test(command) || MAY_RELAY.test(plain))) return null;
  const relay = expand(command).items.some((item) => {
    if (!runsAgent(item.verb, item.argv)) return false;
    const expanded = /[$`]/.test(item.seg);
    return carriesCode(expanded ? command : receivedText(command, item.seg), expanded);
  });
  if (!relay) return null;
  return {
    kind: "block",
    title: "Approval relay guard",
    reason: "A CONFIRM <code> comes only from the owner typing it in their own session; an agent cannot relay it through a nested agent CLI. Move the target to the trash instead, or ask the owner to type the code.",
  };
}
