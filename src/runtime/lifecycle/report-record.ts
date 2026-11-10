/**
 * @module report-record
 * Persistence of the guard-emission records used by {@link ./report-recovery}: ONE file per
 * (session, agent) under `<fusengine cache>/guard-reports/<sid>.<agentId>.json`, written to a
 * temp file then renamed (atomic). No read-modify-write of a shared file, so concurrent
 * SubagentStop processes never lose each other's record. No report text is ever stored here.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../util/json-io";
import { fusengineCache } from "../home-state";
import { pruneOld } from "./report-prune";

/** Guard emission records older than this are deleted on each write (7 days). */
const RETENTION_MS = 7 * 24 * 3600 * 1000;
/** Notification fingerprints remembered per record (oldest dropped). */
const MAX_DELIVERED = 20;

/** What is remembered about a guarded SubagentStop (no report text is stored). */
export interface GuardRecord {
  agentId: string;
  agentType: string;
  transcript: string;
  ts: string;
  /** `uuid` of the agent's last assistant text entry at stop time (best effort). */
  lastUuid?: string;
  /** sha256 of the trimmed last assistant message at stop time. */
  hash?: string;
  /** Fingerprints of the background notifications already injected for this record. */
  delivered?: string[];
}

const reportsDir = (home: string): string => join(fusengineCache(home), "guard-reports");
const recordPath = (sid: string, agentId: string, home: string): string => join(reportsDir(home), `${sid}.${agentId}.json`);

/**
 * The guard record of one agent.
 * @param sid - Sanitized session id.
 * @param agentId - Validated agent id.
 * @param home - Home dir.
 * @returns The record, or `null` when absent or unreadable.
 */
export function loadRecord(sid: string, agentId: string, home: string): GuardRecord | null {
  try {
    const data: unknown = JSON.parse(readFileSync(recordPath(sid, agentId, home), "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) && (data as GuardRecord).agentId === agentId ? (data as GuardRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Persist one agent's record atomically, pruning expired report files first. Throws on I/O failure (callers are best effort).
 * @param sid - Sanitized session id.
 * @param home - Home dir.
 * @param record - The record to write (replaces any previous one of that agent).
 */
export function saveRecord(sid: string, home: string, record: GuardRecord): void {
  mkdirSync(reportsDir(home), { recursive: true, mode: 0o700 });
  pruneOld(reportsDir(home), RETENTION_MS);
  atomicWrite(recordPath(sid, record.agentId, home), JSON.stringify({ ...record, delivered: record.delivered?.slice(-MAX_DELIVERED) }));
}

/**
 * Delete one agent's record (no-op when absent).
 * @param sid - Sanitized session id.
 * @param agentId - Validated agent id.
 * @param home - Home dir.
 */
export function removeRecord(sid: string, agentId: string, home: string): void {
  rmSync(recordPath(sid, agentId, home), { force: true });
}
