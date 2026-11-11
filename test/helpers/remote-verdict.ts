import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGuard } from "../../src/policy/guards/install";
import { securityGuard } from "../../src/policy/guards/security";
import { setHostResolver } from "../../src/policy/remote-target-resolve";

/** Deterministic local resolution for the tests: unknown names do not exist; two fixtures resolve to loopback / an own-looking address. */
setHostResolver((h) => (h === "evil.example.com" ? ["127.0.0.1"] : h === "v6.example.com" ? ["::ffff:127.0.0.1"] : h === "slow.example.com" ? null : []));

/** Verdict of the two local-only guards (security first, then install) for one Bash command: `block`, `ask` or `allow`. */
export function remoteVerdict(command: string): string {
  const ctx = { tool: "Bash", command };
  return securityGuard(ctx)?.kind ?? installGuard(ctx)?.kind ?? "allow";
}

const made: string[] = [];
process.on("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh empty temp directory, removed when the test process exits. */
export function tmpHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Run `fn` with `HOME` pointed at `home` (restored afterwards), so the ssh-config reader sees a controlled tree. */
export function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
  }
}
