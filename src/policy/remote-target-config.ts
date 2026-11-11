import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ConfigTarget } from "./interfaces/remote-target";

/** Strip one pair of surrounding double quotes (OpenSSH does, for `Host`, `Include` and `HostName` operands). */
const unquote = (s: string): string => s.replace(/^"(.*)"$/, "$1");

/** Directives that make the destination (or a local command) depend on something other than the typed host. */
const DANGEROUS = new Set(["proxycommand", "proxyjump", "localcommand", "permitlocalcommand", "match", "controlpath", "controlmaster"]);
const MAX_DEPTH = 4;

/** Glob match of an ssh `Host` pattern (`*`, `?`) against `host`, case-insensitively. */
function patternMatches(pattern: string, host: string): boolean {
  const re = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(host.toLowerCase());
}

/** `Host` line verdict: some positive pattern matches and no negated pattern does. */
function hostLineMatches(patterns: string[], host: string): boolean {
  const neg = patterns.filter((p) => p.startsWith("!")).some((p) => patternMatches(p.slice(1), host));
  return !neg && patterns.filter((p) => !p.startsWith("!")).some((p) => patternMatches(p, host));
}

/** Expand an `Include` operand to files; a glob is accepted only in the last path segment. */
function includeFiles(arg: string, base: string, home: string): string[] | null {
  const p = arg.replace(/^~(?=\/|$)/, home);
  const full = p.startsWith("/") ? p : resolve(base, p);
  if (/[[\]"']/.test(full)) return null;
  if (!/[*?]/.test(full)) return existsSync(full) ? [full] : [];
  const dir = dirname(full);
  if (/[*?]/.test(dir)) return null;
  if (!existsSync(dir)) return [];
  const last = full.slice(dir.length + 1);
  return readdirSync(dir).filter((f) => patternMatches(last, f)).sort().map((f) => join(dir, f));
}

/** Walk one config file; mutates `out`. Returns false when anything cannot be evaluated. */
function walk(file: string, host: string, base: string, home: string, depth: number, out: ConfigTarget): boolean {
  if (depth > MAX_DEPTH || !existsSync(file)) return depth <= MAX_DEPTH;
  let active = true;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    const key = (m?.[1] ?? line).toLowerCase();
    const val = (m?.[2] ?? "").trim();
    if (key === "match") return false;
    if (key === "canonicalizehostname" && val.toLowerCase() !== "no") return false; // re-parses the whole config under another name
    if (key === "host") { active = hostLineMatches(val.split(/\s+/).map(unquote), host); continue; }
    if (key === "include") {
      if (!active) continue; // OpenSSH: an Include inside a non-matching Host block never matches (SSHCONF_NEVERMATCH)
      for (const a of val.split(/\s+/)) {
        const files = includeFiles(unquote(a), base, home);
        if (!files) return false;
        for (const f of files) if (!walk(f, host, base, home, depth + 1, out)) return false;
      }
      continue;
    }
    if (!active) continue;
    if (DANGEROUS.has(key)) return false;
    if (key === "hostname" && out.hostName === undefined) out.hostName = unquote(val).replace(/%h/g, host);
  }
  return true;
}

/**
 * Read the user's (`$HOME/.ssh/config`) and the system (`/etc/ssh/ssh_config`) ssh client configuration, read-only,
 * and report whether `host` may map somewhere other than itself. Any read/parse trouble, `Match`, ProxyCommand,
 * ProxyJump, LocalCommand, PermitLocalCommand, unresolved `Include` or dynamic `HostName` yields `unknown: true`.
 * @param host - Destination host as typed (no `user@`).
 */
export function sshConfigTarget(host: string): ConfigTarget {
  const out: ConfigTarget = { unknown: false };
  try {
    // OpenSSH reads the passwd home (getpwuid), not $HOME; both are walked, and anything unknown in either wins.
    const homes = [...new Set([process.env["HOME"] || homedir(), userInfo().homedir])];
    const ok = homes.every((home) => walk(join(home, ".ssh", "config"), host, join(home, ".ssh"), home, 0, out))
      && walk("/etc/ssh/ssh_config", host, "/etc/ssh", homes[0] ?? homedir(), 0, out);
    if (!ok || (out.hostName !== undefined && /[%$~`\s]/.test(out.hostName))) return { unknown: true };
  } catch {
    return { unknown: true };
  }
  return out;
}
