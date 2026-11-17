/**
 * @module integrity
 * HMAC-SHA256 tamper-evident wrapping for {@link SessionTrack}.
 *
 * Failure policy: ONLY a MAC mismatch causes fail-closed (returns null).
 * The nonce is included in the signed payload and written to disk for advisory
 * diagnostics, but is NOT checked during verification — concurrent hook
 * invocations (PostToolUse, SubagentStop, …) legitimately load the same
 * envelope after the nonce watermark advances; a monotonic check would trigger
 * spurious fail-closed behaviour mid-session.
 *
 * The machine key is readable by the same agent process, so this deters naive
 * out-of-band tampering — not a determined re-sign. Item B (transcript-grounded
 * freshness) is the primary guarantee.
 * @packageDocumentation
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fuseHarnessHome } from "../runtime/home-state";
import type { SessionTrack } from "./session-state";

/** `~/.fuse-harness`, resolved at CALL time: a HOME change after import (tests, spawned children inheriting the current env) must resolve the same key dir as the child, or its signed events are rejected. */
const harnessDir = (): string => fuseHarnessHome();
const keyPath = (): string => join(harnessDir(), ".key");
const noncePath = (): string => join(harnessDir(), ".nonce");

/** Signed envelope wrapping a JSON-serialised {@link SessionTrack}. */
export interface TrackEnvelope {
  /** JSON-serialised SessionTrack. */
  data: string;
  /** Advisory timestamp (Date.now() at sign time); embedded in the MAC. */
  nonce: number;
  /** HMAC-SHA256 hex digest over `"${nonce}:${data}"`. */
  mac: string;
}

/** The per-machine key if it exists — NEVER creates it (read/verify paths must not mint a key: a verifier on a fresh HOME would otherwise accept an empty track as valid under a brand-new key). `null` = no key yet. */
export function readKey(): string | null {
  try {
    const k = readFileSync(keyPath(), "utf8").trim();
    return k || null;
  } catch { return null; }
}

/** Load (or create on first use) the per-machine HMAC key stored at mode 0600. */
export function loadOrCreateKey(): string {
  mkdirSync(harnessDir(), { recursive: true });
  if (existsSync(keyPath())) return readFileSync(keyPath(), "utf8").trim();
  // Race-tolerant creation ("wx" crowns ONE creator): before, N concurrent
  // first-time processes (virgin home — CI) each signed with their OWN key.
  const candidate = randomBytes(32).toString("hex");
  try {
    writeFileSync(keyPath(), candidate, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return candidate;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  // The winner's 64-byte write is one write(2); bounded re-reads cover the gap.
  for (let i = 0; i < 5; i++) {
    const existing = readFileSync(keyPath(), "utf8").trim();
    if (existing) return existing;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  const key = readFileSync(keyPath(), "utf8").trim();
  if (!key) throw new Error("fuse: empty .key after write contention");
  return key;
}

/**
 * Persist the last-seen nonce for advisory diagnostics (mode 0600).
 * Never read during {@link verifyTrack} — see module JSDoc for rationale.
 */
export function writeLastNonce(nonce: number): void {
  mkdirSync(harnessDir(), { recursive: true });
  writeFileSync(noncePath(), String(nonce), { encoding: "utf8", mode: 0o600 });
}

/** Compute HMAC-SHA256 over `"${nonce}:${data}"` (nonce: envelope number or journal per-line string). */
export function computeMac(key: string, data: string, nonce: number | string): string {
  return createHmac("sha256", key).update(`${nonce}:${data}`).digest("hex");
}

/**
 * Sign a {@link SessionTrack} into a tamper-evident envelope. The nonce
 * (`Date.now()`) is embedded in the MAC to bind the timestamp to the payload.
 */
export function signTrack(track: SessionTrack): TrackEnvelope {
  const key = loadOrCreateKey();
  const data = JSON.stringify(track);
  const nonce = Date.now();
  return { data, nonce, mac: computeMac(key, data, nonce) };
}

/**
 * Verify a {@link TrackEnvelope}. Returns the parsed {@link SessionTrack} on
 * success, or `null` ONLY on MAC mismatch / parse failure (fail-closed on
 * tampering). The nonce is NOT checked — see module JSDoc.
 */
export function verifyTrack(envelope: TrackEnvelope): SessionTrack | null {
  const key = readKey(); // read path: never creates the key
  return key === null ? null : verifyEnvelope(envelope, key);
}

/** Verify an envelope against an explicit key (null on MAC mismatch / parse failure). */
export function verifyEnvelope(envelope: TrackEnvelope, key: string): SessionTrack | null {
  try {
    if (envelope.mac !== computeMac(key, envelope.data, envelope.nonce)) return null;
    return JSON.parse(envelope.data) as SessionTrack;
  } catch {
    return null;
  }
}
