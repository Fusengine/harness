/**
 * Thin fail-closed wrappers over `util/json-io.ts` + the `prd-schema.ts`
 * parsers. Both async (CLI, PostToolUse) and sync (SubagentStart/Stop, which
 * must not float async work) variants. The only two files in this module
 * that touch disk (besides `prd-enabled.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { readJsonFile, writeJsonFile } from "../../util/json-io";
import { prdAgentReportPath, prdRouterPath, prdTaskPath } from "./prd-paths";
import { parseAgentReportFile, parseTaskFile } from "./prd-schema";
import { classifyRouterText } from "./prd-router-state";
import type { PrdAgentReportFile, PrdRouter, PrdRouterSnapshot, PrdRouterState, PrdTaskFile } from "./interfaces/types";

function readJsonSync(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** One read of the router file -> raw text + {@link PrdRouterState}; an unreadable file (e.g. a directory) is a `syntax` state, never `absent`. */
export function readRouterSnapshotSync(root: string, homeSeg: string): PrdRouterSnapshot {
  const path = prdRouterPath(root, homeSeg);
  if (!existsSync(path)) return { text: null, state: { state: "absent" } };
  try {
    const text = readFileSync(path, "utf8");
    return { text, state: classifyRouterText(text) };
  } catch (err) {
    return { text: null, state: { state: "syntax", error: `cannot read file (${err instanceof Error ? err.message : String(err)})` } };
  }
}

/** Reads the router file's {@link PrdRouterState} (absent / syntax / schema / ok). */
export async function readRouterState(root: string, homeSeg: string): Promise<PrdRouterState> {
  return readRouterSnapshotSync(root, homeSeg).state;
}

/** Reads the router file; `null` when missing or malformed (any non-ok state). */
export async function readRouter(root: string, homeSeg: string): Promise<PrdRouter | null> {
  const state = await readRouterState(root, homeSeg);
  return state.state === "ok" ? state.router : null;
}

/** Sync twin of {@link readRouter}, for SubagentStart/Stop call sites. */
export function readRouterSync(root: string, homeSeg: string): PrdRouter | null {
  const { state } = readRouterSnapshotSync(root, homeSeg);
  return state.state === "ok" ? state.router : null;
}

/** Reads a task-PRD file; `null` when missing or malformed. */
export async function readTaskFile(root: string, homeSeg: string, relPrd: string): Promise<PrdTaskFile | null> {
  const raw = await readJsonFile<unknown>(prdTaskPath(root, homeSeg, relPrd));
  return raw === null ? null : parseTaskFile(raw);
}

/** Sync twin of {@link readTaskFile}. */
export function readTaskFileSync(root: string, homeSeg: string, relPrd: string): PrdTaskFile | null {
  const raw = readJsonSync(prdTaskPath(root, homeSeg, relPrd));
  return raw === null ? null : parseTaskFile(raw);
}

/** Reads every task-PRD file named in `router`, keyed by task name (`null` per unreadable/malformed entry). */
export async function readAllTaskFiles(
  root: string,
  homeSeg: string,
  router: PrdRouter,
): Promise<Record<string, PrdTaskFile | null>> {
  const out: Record<string, PrdTaskFile | null> = {};
  for (const [task, entry] of Object.entries(router)) {
    out[task] = await readTaskFile(root, homeSeg, entry.prd);
  }
  return out;
}

/** Reads an agent's own report file; `null` when missing or malformed. */
export async function readAgentReport(root: string, homeSeg: string, agent: string): Promise<PrdAgentReportFile | null> {
  const raw = await readJsonFile<unknown>(prdAgentReportPath(root, homeSeg, agent));
  return raw === null ? null : parseAgentReportFile(raw);
}

/** Sync twin of {@link readAgentReport}. */
export function readAgentReportSync(root: string, homeSeg: string, agent: string): PrdAgentReportFile | null {
  const raw = readJsonSync(prdAgentReportPath(root, homeSeg, agent));
  return raw === null ? null : parseAgentReportFile(raw);
}

/** Atomically writes the router file. */
export async function writeRouter(root: string, homeSeg: string, router: PrdRouter): Promise<void> {
  await writeJsonFile(prdRouterPath(root, homeSeg), router);
}

/** Atomically writes a task-PRD file. */
export async function writeTaskFile(root: string, homeSeg: string, relPrd: string, file: PrdTaskFile): Promise<void> {
  await writeJsonFile(prdTaskPath(root, homeSeg, relPrd), file);
}

/** Atomically writes an agent's own report file. */
export async function writeAgentReport(
  root: string,
  homeSeg: string,
  agent: string,
  file: PrdAgentReportFile,
): Promise<void> {
  await writeJsonFile(prdAgentReportPath(root, homeSeg, agent), file);
}
