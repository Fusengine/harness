import { spawnSync } from "node:child_process";
import type { HostResolver } from "./interfaces/remote-target";

const LOOKUP_TIMEOUT_MS = 300;
const SCRIPT =
  'require("node:dns").lookup(process.env.FUSE_RT_HOST,{all:true},(e,r)=>{process.stdout.write(JSON.stringify(e?{e:e.code}:{a:r.map((x)=>x.address)}))})';
const cache = new Map<string, string[] | null>();
let override: HostResolver | null = null;

/**
 * Local resolution of `host` through the runtime's own `dns.lookup` in a child, killed after 300 ms; never cached, never overridden.
 * @param host - Host name to resolve.
 * @returns The addresses, `[]` when the name does not exist, or null on timeout or any other failure.
 */
export function lookupInChild(host: string): string[] | null {
  const r = spawnSync(process.execPath, ["-e", SCRIPT], {
    env: { PATH: process.env["PATH"] ?? "", FUSE_RT_HOST: host },
    cwd: "/", // never the project directory: no bunfig.toml / .env / preload of the project can influence the lookup
    timeout: LOOKUP_TIMEOUT_MS,
    killSignal: "SIGKILL",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.error || r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { a?: string[]; e?: string };
    if (j.a) return j.a;
    return j.e === "ENOTFOUND" || j.e === "ENODATA" ? [] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve `host` locally (`dns.lookup`, all addresses, 300 ms ceiling), cached per process.
 * @param host - Host name to resolve.
 * @returns The addresses, `[]` when the name does not exist, or null on timeout or any other failure.
 */
export function resolveHost(host: string): string[] | null {
  if (override) return override(host);
  if (!cache.has(host)) cache.set(host, lookupInChild(host));
  return cache.get(host) ?? null;
}

/**
 * Replace the resolver (tests only); pass null to restore the real lookup.
 * @param r - Replacement resolver, or null.
 */
export function setHostResolver(r: HostResolver | null): void {
  override = r;
}
