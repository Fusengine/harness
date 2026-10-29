import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalGate } from "../src/policy/motion/gates";
import { grantPending, listApprovals, listPending } from "../src/policy/motion/approvals";
import { sha256File, rootKey } from "../src/policy/motion/hash";
import { loadMotionProject } from "../src/policy/motion/project";
import { projectStoreDir } from "../src/policy/motion/store";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "motion-auth-root-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "motion-auth-home-")));
  mkdirSync(join(root, ".motion", "stills"), { recursive: true });
  writeFileSync(join(root, ".motion", "project.json"), "{}");
  const project = loadMotionProject(root, home)!;
  writeFileSync(project.contact, "sheet");
  const cmd = { renderStage: "draft" as const, ffmpegMaster: false };
  const gate = () => approvalGate(cmd, project, "session", 100, home, {});
  gate();
  return { root, home, project, gate };
}

test("HMAC: unsigned historical approvals require explicit re-approval", () => {
  const f = fixture();
  writeFileSync(join(projectStoreDir(f.root, f.home), "approvals.json"), JSON.stringify({ approvals: [{ stage: "stills", sha256: sha256File(f.project.contact) }] }));
  expect(f.gate()?.reason).toContain("re-approve required");
});

test("HMAC: human grant signs canonical project/artifact/hash/time and tampering denies", () => {
  const f = fixture(), pending = listPending(f.root, f.home)[0]!;
  grantPending(f.root, "session", "stills", pending.code, pending.sha256, 200, f.home);
  expect(f.gate()).toBeNull();
  const a = listApprovals(f.root, f.home)[0]!;
  expect(a).toMatchObject({ version: 1, rootKey: rootKey(f.root) });
  expect(a.signature).toMatch(/^[a-f0-9]{64}$/);
  for (const change of [{ approvedAt: 201 }, { artifact: "/other.png" }, { rootKey: "other" }, { signature: "x" },
    { signature: "0".repeat(64) }, { sha256: "0".repeat(64) }, { version: 2 }]) {
    writeFileSync(join(projectStoreDir(f.root, f.home), "approvals.json"), JSON.stringify({ approvals: [{ ...a, ...change }] }));
    expect(f.gate()?.reason).toContain("re-approve required");
  }
});

test("HMAC: unreadable or over-permissive key never unlocks a gate", () => {
  const f = fixture(), pending = listPending(f.root, f.home)[0]!;
  grantPending(f.root, "session", "stills", pending.code, pending.sha256, 200, f.home);
  const key = join(f.home, ".fuse-harness", "video-motion", "keys", `${rootKey(f.root)}.key`);
  expect(readFileSync(key).byteLength).toBeGreaterThanOrEqual(32);
  chmodSync(key, 0o644);
  expect(f.gate()?.reason).toContain("re-approve required");
});

test("HMAC: gates do not generate missing keys and reject symlink or replaced keys", () => {
  const f = fixture(), pending = listPending(f.root, f.home)[0]!;
  grantPending(f.root, "session", "stills", pending.code, pending.sha256, 200, f.home);
  const path = join(f.home, ".fuse-harness", "video-motion", "keys", `${rootKey(f.root)}.key`);
  const key = readFileSync(path), elsewhere = join(f.home, "elsewhere");
  unlinkSync(path);
  expect(f.gate()?.reason).toContain("re-approve required");
  expect(existsSync(path)).toBe(false);
  writeFileSync(elsewhere, key, { mode: 0o600 });
  symlinkSync(elsewhere, path);
  expect(f.gate()?.reason).toContain("re-approve required");
  unlinkSync(path);
  writeFileSync(path, Buffer.alloc(32), { mode: 0o600 });
  expect(f.gate()?.reason).toContain("re-approve required");
});
