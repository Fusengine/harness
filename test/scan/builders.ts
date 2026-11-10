/**
 * @module test/scan/builders
 * Runtime tree builders for the scanner tests. Fixtures (including fake
 * secrets) are generated into a mkdtemp root, never committed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A tree spec: relative path -> file content. */
export type TreeSpec = Record<string, string | Uint8Array>;

/** Fake AWS key id, split so no literal key sits in the repo. */
export const FAKE_AWS: string = "AKIA" + "IOSFODNN7EXAMPLE";

/** Assemble `key<sep>value` at runtime so no source line literally looks like a hardcoded credential. */
export function kv(key: string, value: string, sep = " = "): string {
  return key + sep + value;
}

/** Roots created by {@link makeTree}, removed by {@link cleanupTrees}. */
const created: string[] = [];

/** Create a temp tree from `spec` and return its root. */
export function makeTree(spec: TreeSpec): string {
  const root = mkdtempSync(join(tmpdir(), "scan-t-"));
  created.push(root);
  writeTree(root, spec);
  return root;
}

/** Write `spec` under an existing `root`. */
export function writeTree(root: string, spec: TreeSpec): void {
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Remove every tree created through {@link makeTree}. */
export function cleanupTrees(): void {
  for (const r of created.splice(0)) rmSync(r, { recursive: true, force: true });
}

/** Minimal finding shape shared by legacy and new reports. */
export interface BaseFinding { severity: string; category: string; pattern: string; file: string; line: number }

/** Order-independent key of the 5 legacy finding fields. */
export function tuple(f: BaseFinding): string {
  return JSON.stringify([f.severity, f.category, f.pattern, f.file, f.line]);
}

/** Replace `root` by `<ROOT>` and sort, for stable golden comparison. */
export function normalise(rep: { language: string; summary: Record<string, number>; findings: BaseFinding[] }, root: string): unknown {
  const findings = rep.findings.map((f) => ({ ...f, file: f.file.replace(root, "<ROOT>") }));
  findings.sort((a, b) => tuple(a).localeCompare(tuple(b)));
  return { language: rep.language, summary: rep.summary, findings: findings.map((f) => [f.severity, f.category, f.pattern, f.file, f.line]) };
}
