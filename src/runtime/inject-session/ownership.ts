/**
 * @module inject-session/ownership
 * Decides, deterministically, who OWNS a scope's injection on Claude Code.
 * The owner's `settings.json` registers `hooks-loader.ts` for every event; the
 * loader runs the hook commands of EVERY installed plugin, enabled or not,
 * while Claude Code itself runs only the ENABLED plugins' hooks natively. So a
 * scope registered (for an event) only by plugins that are not enabled has no
 * native copy: its loader copy must act as the owner. The loader concatenates
 * all its children's output into ONE field, so owners share one budget (their
 * count is returned for that). Anything unconfirmable answers "not owner",
 * which keeps the loader copy on its read-only, HEAD-printing path.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../home-state";
import { maxSemver } from "../../util/semver";

/** Result of {@link loaderOwnership}. */
export interface Ownership {
  /** This scope has no native copy for the event: the loader copy owns it. */
  owner: boolean;
  /** How many scopes are loader-only for the event (they share the merged 10 000-char field). */
  owners: number;
  /** An ENABLED plugin registers this scope for the event: a native copy provably runs, so the loader's duplicate must stay silent. */
  native: boolean;
}

/** One hook command registration: the scope it runs and the tool-name matcher of its group ("" = every tool). */
interface Reg {
  scope: string;
  matcher: string;
}

/** Plugin id (`name@marketplace`) -> event -> registrations of its hooks.json. */
type Registry = Map<string, Map<string, Reg[]>>;

/** Does a registration fire for `tool` (always, when no tool is given)? */
function fires(r: Reg, tool: string | undefined): boolean {
  if (!r.matcher || tool === undefined) return true;
  try { return new RegExp(`^(?:${r.matcher})$`).test(tool); } catch { return true; }
}

/** The hooks-loader's own matcher test: an UNANCHORED RegExp (`new RegExp(m).test(v)`), an invalid one never fires. */
function loaderFires(matcher: string, value: string): boolean {
  if (!matcher) return true;
  try { return new RegExp(matcher).test(value); } catch { return false; }
}

const NONE: Ownership = { owner: false, owners: 0, native: false };

/** Parse a JSON file: undefined when missing, null when unparsable. */
function readJson(path: string): Record<string, unknown> | undefined | null {
  if (!existsSync(path)) return undefined;
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Scope a `hook claude-code [scope] [flags]` command runs (bare or flag-only = core), or null for other commands. */
function scopeOf(cmd: string): string | null {
  const m = /hook claude-code(?:\s+([a-z][a-z-]*))?/.exec(cmd);
  if (!m) return null;
  return m[1] ?? "core";
}

/** Merged `enabledPlugins` (user < project < local), or null when a layer is unparsable. */
function enabledPlugins(home: string, proj: string): Set<string> | null {
  const on = new Map<string, boolean>();
  const layers = [join(claudeHome(home), "settings.json"), join(proj, ".claude", "settings.json"), join(proj, ".claude", "settings.local.json")];
  for (const f of layers) {
    const j = readJson(f);
    if (j === null) return null;
    const ep = j?.enabledPlugins;
    if (ep && typeof ep === "object") for (const [k, v] of Object.entries(ep)) on.set(k, v === true);
  }
  return new Set([...on].filter(([, v]) => v).map(([k]) => k));
}

/** Events -> scopes of one plugin directory's hooks.json. */
function hookScopes(dir: string): Map<string, Reg[]> {
  const out = new Map<string, Reg[]>();
  const hooks = (readJson(join(dir, "hooks", "hooks.json"))?.hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  for (const [ev, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g.hooks ?? []) {
        const s = typeof h.command === "string" ? scopeOf(h.command) : null;
        if (s) out.set(ev, [...(out.get(ev) ?? []), { scope: s, matcher: g.matcher ?? "" }]);
      }
    }
  }
  return out;
}

/** Installed plugins: marketplace clones (name from plugin.json) and the plugin cache (`cache/<mk>/<name>/<ver>`). */
function installed(home: string): Registry {
  const reg: Registry = new Map();
  const base = join(claudeHome(home), "plugins");
  const list = (d: string): string[] => { try { return readdirSync(d); } catch { return []; } };
  for (const mk of list(join(base, "marketplaces"))) {
    for (const dir of list(join(base, "marketplaces", mk, "plugins"))) {
      const root = join(base, "marketplaces", mk, "plugins", dir);
      const name = readJson(join(root, ".claude-plugin", "plugin.json"))?.name;
      if (typeof name === "string") reg.set(`${name}@${mk}`, hookScopes(root));
    }
  }
  for (const mk of list(join(base, "cache"))) {
    for (const name of list(join(base, "cache", mk))) {
      const ver = maxSemver(list(join(base, "cache", mk, name))); // numeric order: 1.0.14 > 1.0.9 (a lexical sort gets it backwards)
      if (ver) reg.set(`${name}@${mk}`, hookScopes(join(base, "cache", mk, name, ver)));
    }
  }
  return reg;
}

/**
 * The order in which the hooks-loader merges its children's output for an event: it lists
 * `<home>/.claude/plugins/marketplaces/fusengine-plugins/plugins` (directory listing order), keeps
 * each plugin's hooks.json registrations for the event in file order, drops those whose matcher
 * (tested against `matchValue`: the tool name, or the agent type for SubagentStart) does not fire,
 * and runs them all in parallel but merges in that sequence.
 * @param home - Home dir (the loader reads `$HOME/.claude/...`).
 * @param event - Hook event name.
 * @param matchValue - Value the matchers are tested against ("" = none).
 * @returns Plugin scopes, first occurrence only, in merge order ([] when the loader dir is unreadable).
 */
export function loaderOrder(home: string, event: string, matchValue: string): string[] {
  const out: string[] = [];
  try {
    const dir = join(home, ".claude", "plugins", "marketplaces", "fusengine-plugins", "plugins");
    for (const d of readdirSync(dir)) {
      for (const r of hookScopes(join(dir, d)).get(event) ?? []) {
        if (loaderFires(r.matcher, matchValue) && !out.includes(r.scope)) out.push(r.scope);
      }
    }
  } catch { /* unreadable: order unknown */ }
  return out;
}

/**
 * Is `scope` loader-only for `event`, and how many scopes are?
 * @param home - Home dir (user settings, installed plugins).
 * @param proj - Project dir (project and local settings).
 * @param event - Hook event name.
 * @param scope - Plugin scope of the calling hook process.
 * @param tool - Tool name for tool events: only registrations whose matcher covers it count.
 * @returns `{owner:false, owners:0}` when anything cannot be confirmed.
 */
export function loaderOwnership(home: string, proj: string, event: string, scope: string, tool?: string): Ownership {
  try {
    const enabled = enabledPlugins(home, proj);
    if (!enabled) return NONE;
    const all = new Set<string>();
    const native = new Set<string>();
    for (const [id, events] of installed(home)) {
      for (const r of (events.get(event) ?? []).filter((x) => fires(x, tool))) {
        all.add(r.scope);
        if (enabled.has(id)) native.add(r.scope);
      }
    }
    const owners = [...all].filter((s) => !native.has(s));
    return { owner: owners.includes(scope), owners: owners.length, native: native.has(scope) };
  } catch {
    return NONE;
  }
}
