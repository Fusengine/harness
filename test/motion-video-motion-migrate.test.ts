import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { motionHome, motionKeyDirectory } from "../src/policy/motion/store";
import { migrateMotionData, resetMotionMigrationMemo } from "../src/policy/motion/migrate";

/** Migration of the pre-relocation layout (motion/, motion-keys/) into ~/.fuse-harness/video-motion. */
const made: string[] = [];
const fresh = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "motion-vm-mig-"))); made.push(dir); return dir; };
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** Build a home with an old-layout store + key. */
function legacyHome(): { home: string; key: string; approvals: string } {
  const h = fresh();
  mkdirSync(join(h, ".fuse-harness/motion/k1"), { recursive: true });
  mkdirSync(join(h, ".fuse-harness/motion-keys"), { recursive: true, mode: 0o700 });
  writeFileSync(join(h, ".fuse-harness/motion/k1/approvals.json"), '{"a":1}');
  writeFileSync(join(h, ".fuse-harness/motion/banned.txt"), "acme\n");
  writeFileSync(join(h, ".fuse-harness/motion-keys/p.key"), "KEYBYTES", { mode: 0o600 });
  return { home: h, key: join(h, ".fuse-harness/video-motion/keys/p.key"), approvals: join(h, ".fuse-harness/video-motion/k1/approvals.json") };
}
const mode = (path: string): number => statSync(path).mode & 0o777;

test("old only: store and keys move atomically with content and modes preserved; idempotent", () => {
  const l = legacyHome();
  resetMotionMigrationMemo();
  migrateMotionData(l.home);
  expect(readFileSync(l.key, "utf8")).toBe("KEYBYTES");
  expect(mode(l.key)).toBe(0o600);
  expect(mode(join(l.home, ".fuse-harness/video-motion/keys"))).toBe(0o700);
  expect(readFileSync(l.approvals, "utf8")).toBe('{"a":1}');
  expect(readFileSync(join(l.home, ".fuse-harness/video-motion/banned.txt"), "utf8")).toBe("acme\n");
  expect(existsSync(join(l.home, ".fuse-harness/motion"))).toBe(false);
  expect(existsSync(join(l.home, ".fuse-harness/motion-keys"))).toBe(false);
  resetMotionMigrationMemo();
  migrateMotionData(l.home);
  expect(readFileSync(l.key, "utf8")).toBe("KEYBYTES");
});

test("motionKeyDirectory() triggers the migration on first resolve", () => {
  const l = legacyHome();
  resetMotionMigrationMemo();
  expect(readFileSync(join(motionKeyDirectory(l.home), "p.key"), "utf8")).toBe("KEYBYTES");
  expect(existsSync(l.approvals)).toBe(true);
});

test("new only: nothing is created or touched", () => {
  const h = fresh();
  mkdirSync(join(h, ".fuse-harness/video-motion/keys"), { recursive: true });
  writeFileSync(join(h, ".fuse-harness/video-motion/keys/n.key"), "NEW");
  resetMotionMigrationMemo();
  migrateMotionData(h);
  expect(readdirSync(join(h, ".fuse-harness")).sort()).toEqual(["video-motion"]);
  expect(readFileSync(join(h, ".fuse-harness/video-motion/keys/n.key"), "utf8")).toBe("NEW");
});

test("neither exists: no directory is created", () => {
  const h = fresh();
  resetMotionMigrationMemo();
  migrateMotionData(h);
  expect(existsSync(join(h, ".fuse-harness"))).toBe(false);
});

test("both exist: nothing is overwritten, missing children are merged, old leftovers stay in place", () => {
  const l = legacyHome();
  mkdirSync(join(l.home, ".fuse-harness/video-motion/keys"), { recursive: true });
  writeFileSync(join(l.home, ".fuse-harness/video-motion/keys/n.key"), "NEWKEY");
  writeFileSync(join(l.home, ".fuse-harness/video-motion/banned.txt"), "mine\n");
  resetMotionMigrationMemo();
  migrateMotionData(l.home);
  expect(readFileSync(join(l.home, ".fuse-harness/video-motion/keys/n.key"), "utf8")).toBe("NEWKEY");
  expect(readFileSync(l.key, "utf8")).toBe("KEYBYTES");
  expect(readFileSync(join(l.home, ".fuse-harness/video-motion/banned.txt"), "utf8")).toBe("mine\n");
  expect(readFileSync(join(l.home, ".fuse-harness/motion/banned.txt"), "utf8")).toBe("acme\n");
  expect(readFileSync(l.approvals, "utf8")).toBe('{"a":1}');
});

test("a planted root fails closed: symlink, group-writable, or a same-name key whose content differs", () => {
  const link = fresh();
  mkdirSync(join(link, ".fuse-harness"), { recursive: true });
  symlinkSync(fresh(), join(link, ".fuse-harness/video-motion"));
  resetMotionMigrationMemo();
  expect(() => migrateMotionData(link)).toThrow(/refusing to use it/);
  expect(() => motionHome(link)).toThrow();

  const loose = fresh();
  mkdirSync(join(loose, ".fuse-harness/video-motion"), { recursive: true });
  chmodSync(join(loose, ".fuse-harness/video-motion"), 0o777);
  resetMotionMigrationMemo();
  expect(() => migrateMotionData(loose)).toThrow(/refusing to use it/);

  const l = legacyHome();
  mkdirSync(join(l.home, ".fuse-harness/video-motion/keys"), { recursive: true });
  writeFileSync(join(l.home, ".fuse-harness/video-motion/keys/p.key"), "PLANTED");
  resetMotionMigrationMemo();
  expect(() => migrateMotionData(l.home)).toThrow(/different content/);
  expect(readFileSync(join(l.home, ".fuse-harness/motion-keys/p.key"), "utf8")).toBe("KEYBYTES");
});

test("a symlinked old directory is refused and never followed", () => {
  const h = fresh();
  const outside = fresh();
  writeFileSync(join(outside, "x"), "OUT");
  mkdirSync(join(h, ".fuse-harness"), { recursive: true });
  symlinkSync(outside, join(h, ".fuse-harness/motion-keys"));
  resetMotionMigrationMemo();
  migrateMotionData(h);
  expect(existsSync(join(h, ".fuse-harness/video-motion/keys"))).toBe(false);
  expect(readFileSync(join(outside, "x"), "utf8")).toBe("OUT");
});

test("a read-only key keeps its mode through the move", () => {
  const l = legacyHome();
  chmodSync(join(l.home, ".fuse-harness/motion-keys/p.key"), 0o400);
  resetMotionMigrationMemo();
  migrateMotionData(l.home);
  expect(readFileSync(l.key, "utf8")).toBe("KEYBYTES");
  expect(mode(l.key)).toBe(0o400);
});

test("six parallel processes: exactly one key, byte-identical, no loss or duplicate", () => {
  const l = legacyHome();
  const script = `import { migrateMotionData } from ${JSON.stringify(join(import.meta.dir, "../src/policy/motion/migrate.ts"))}; migrateMotionData(process.argv[1]);`;
  const code = `const r = await Promise.all(Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", ${JSON.stringify(script)}, ${JSON.stringify(l.home)}], { stdout: "ignore", stderr: "pipe" }).exited)); process.exit(r.every((c) => c === 0) ? 0 : 1);`;
  const run = spawnSync(process.execPath, ["-e", code], { timeout: 15000, encoding: "utf8" });
  expect(run.status).toBe(0);
  expect(readdirSync(join(l.home, ".fuse-harness/video-motion/keys"))).toEqual(["p.key"]);
  expect(readFileSync(l.key, "utf8")).toBe("KEYBYTES");
  expect(readFileSync(l.approvals, "utf8")).toBe('{"a":1}');
  expect(existsSync(join(l.home, ".fuse-harness/motion"))).toBe(false);
  expect(existsSync(join(l.home, ".fuse-harness/motion-keys"))).toBe(false);
}, 20000);
