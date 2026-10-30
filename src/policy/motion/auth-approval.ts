/** @module motion/auth-approval — authoritative authenticated approval validation for G1/G2. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { ApprovableStage, MotionApproval } from "../interfaces/motion";
import { canonicalFilePath, canonicalRoot } from "../../runtime/prd/prd-canon";
import { rootKey } from "./hash";
import { grantingMotionKey, readMotionKey } from "./auth-key";
import { MotionStoreError } from "./trust";
import { recordMotionGrant, registeredMotionGrant } from "./state-witness";

const HEX = /^[a-f0-9]{64}$/;
const artifactPath = (path: string): string => canonicalFilePath(resolve(path));
const projectKey = (root: string): string => rootKey(canonicalRoot(root));

function canonical(a: MotionApproval): string {
  return JSON.stringify([a.version, a.rootKey, a.stage, a.artifact, a.sha256, a.approvedAt, a.code, a.sessionId]);
}

/** Sign a human grant; no existing unsigned approval is ever silently migrated. */
export function signMotionApproval(root: string, a: MotionApproval, home: string): MotionApproval | null {
  const key = grantingMotionKey(root, home);
  if (!key) return null;
  const signed: MotionApproval = { ...a, version: 1, rootKey: projectKey(root), artifact: artifactPath(a.artifact) };
  const signature = createHmac("sha256", key).update(canonical(signed)).digest("hex");
  recordMotionGrant(root, signature, home);
  return { ...signed, signature };
}

/** Validate content, project and artifact binding, then compare fixed-length HMACs in constant time. */
export function validMotionApproval(root: string, a: MotionApproval | null | undefined, stage: ApprovableStage, sha256: string, artifact: string, home: string): boolean {
  try {
    if (!a || a.version !== 1 || a.rootKey !== projectKey(root) || a.stage !== stage || a.sha256 !== sha256
      || typeof a.artifact !== "string" || a.artifact !== artifactPath(artifact)
      || !Number.isFinite(a.approvedAt) || typeof a.code !== "string" || typeof a.sessionId !== "string"
      || typeof a.signature !== "string" || !HEX.test(a.signature)) return false;
    if (!registeredMotionGrant(root, a.signature, home)) return false;
    const key = readMotionKey(root, home);
    if (!key) return false;
    const expected = createHmac("sha256", key).update(canonical(a)).digest();
    return timingSafeEqual(Buffer.from(a.signature, "hex"), expected);
  } catch (error) {
    // An untrusted key/store layout is not "no approval": surface the real cause (Motion-scoped fail-closed).
    if (error instanceof MotionStoreError) throw error;
    return false;
  }
}
