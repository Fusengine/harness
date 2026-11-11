import { readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { sshConfigTarget } from "./remote-target-config";
import { resolveHost } from "./remote-target-resolve";

const USER_RE = /^[A-Za-z0-9._-]+$/;
const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/;
const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "broadcasthost"]);

/** Names this machine answers to (lower-case): its hostname (full and short) plus the usual env spellings. */
function ownNames(): string[] {
  const raw = [hostname(), process.env["HOSTNAME"], process.env["HOST"], process.env["COMPUTERNAME"]];
  const names = raw.filter((n): n is string => typeof n === "string" && n !== "").map((n) => n.toLowerCase());
  return [...names, ...names.map((n) => n.split(".")[0] ?? n)];
}

/** Addresses of this machine's interfaces. */
function ownAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.add(a.address.toLowerCase());
  return out;
}

/** DNS suffixes that resolve to whatever address is embedded in the name (loopback included): not provable from the string. */
const WILDCARD_DNS = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "vcap.me", "traefik.me", "local.gd", "localho.st"];

/** A strict decimal dotted quad that is neither loopback, the any-address, nor one of this machine's own addresses. */
function isRemoteQuad(h: string): boolean {
  const q = h.split(".");
  if (q.length !== 4 || !q.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)) return false;
  return q[0] !== "127" && q[0] !== "0" && !ownAddresses().has(h);
}

/** True when /etc/hosts maps `host` to loopback / the any-address / one of this machine's addresses, or cannot be read. */
function hostsFileLocal(host: string): boolean {
  let text: string;
  try {
    text = readFileSync("/etc/hosts", "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
  for (const line of text.split("\n")) {
    const [addr, ...names] = line.replace(/#.*/, "").trim().toLowerCase().split(/\s+/);
    if (!addr || !names.includes(host)) continue;
    if (!isRemoteQuad(addr)) return true; // anything but a clearly remote dotted quad (loopback, ::ffff:127.x, own address...) is local
  }
  return false;
}

/**
 * Whether a bare host name/address is PROVEN to be another machine: syntactically plain, not loopback / any-address /
 * this machine's own name or interface address, and not numerically ambiguous (`127.1`, `2130706433`, `0x7f000001`).
 * @param host - Host part only (no `user@`).
 */
function isProvenRemoteName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!HOST_RE.test(h)) return false;
  const labels = h.split(".");
  const first = labels[0] ?? "";
  if (LOOPBACK_NAMES.has(h) || first === "localhost" || labels[labels.length - 1] === "localhost") return false;
  const last = labels[labels.length - 1] ?? "";
  if (/^(?:0x[0-9a-f]*|\d+)$/.test(last)) return isRemoteQuad(h);
  const own = ownNames();
  if (own.includes(h) || own.includes(first) || WILDCARD_DNS.some((s) => h === s || h.endsWith(`.${s}`))) return false;
  if (hostsFileLocal(h)) return false;
  const addrs = resolveHost(h);
  return addrs !== null && !addrs.some(isLocalAddress);
}

/** Loopback, any-address or one of this machine's own addresses (zone ids and IPv4-mapped forms included). */
function isLocalAddress(a: string): boolean {
  const x = a.toLowerCase().replace(/%.*$/, "").replace(/^::ffff:/, "");
  return /^127\./.test(x) || /^0\.0\.0\.0$/.test(x) || x === "::1" || x === "::" || ownAddresses().has(x) || ownAddresses().has(a.toLowerCase());
}

/**
 * Whether a destination word (`[user@]host`) is a PROVEN remote machine: literal, plain, a non-local name
 * (see {@link isProvenRemoteName}) and not redirected by ssh_config to a local or unknown target.
 * @param dest - Decoded destination text.
 */
export function isProvenRemoteDest(dest: string): boolean {
  const at = dest.lastIndexOf("@");
  const user = at < 0 ? "" : dest.slice(0, at);
  const host = at < 0 ? dest : dest.slice(at + 1);
  if (at >= 0 && !USER_RE.test(user)) return false;
  if (!isProvenRemoteName(host)) return false;
  const cfg = sshConfigTarget(host);
  if (cfg.unknown) return false;
  return cfg.hostName === undefined || isProvenRemoteName(cfg.hostName);
}
