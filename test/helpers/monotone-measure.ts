/**
 * Measurement shared by the slow effect test and the report script: for every generated case run
 * the effect oracle and the real hook verdict, then tally bypass (executing yet not blocked) and
 * over-block (neutralised yet blocked).
 */
import { DENY_ATOMS, GAP_ATOMS } from "./monotone-atoms";
import { type Case, execCases, label, neutralCases } from "./monotone-contexts";
import { effect, pool } from "./monotone-oracle";
import { hookVerdict, type Verdict } from "./monotone-verdict";

/** Result row for one case. */
export interface Row {
  label: string;
  kind: Case["kind"];
  gap: boolean;
  depth: number;
  effect: boolean;
  verdict: Verdict;
}

/** Tally of a row set. */
export interface Tally {
  generated: number;
  executed: number;
  allow: number;
  ask: number;
  bypass: number;
  neutral: number;
  neutralBlocked: number;
  neutralAsked: number;
}

/** Run oracle + hook verdict on `cases` (concurrency 3). */
export async function measure(cases: readonly Case[]): Promise<Row[]> {
  return pool(cases, 3, async (c) => ({
    label: label(c),
    kind: c.kind,
    gap: c.atom.gap === true,
    depth: c.chain.length,
    effect: await effect(c.cmd),
    verdict: await hookVerdict(c.cmd),
  }));
}

/** Every k-th element (deterministic sample). */
export function stride<T>(xs: readonly T[], k: number): T[] {
  return xs.filter((_, i) => i % k === 0);
}

/** Standard case set: depth-1 exec (deny+gap atoms), depth-2 exec sampled by `k`, neutral sampled by `k`. */
export function standardCases(k: number): { exec0: Case[]; exec1: Case[]; exec2: Case[]; neutral: Case[] } {
  const atoms = [...DENY_ATOMS, ...GAP_ATOMS];
  const exec0: Case[] = atoms.map((atom) => ({ atom, chain: [], cmd: atom.cmd, kind: "exec" }));
  return { exec0, exec1: execCases(atoms, 1), exec2: stride(execCases(DENY_ATOMS, 2), k), neutral: stride(neutralCases(DENY_ATOMS), k) };
}

/** Tally rows. Bypass = effect happened and verdict is not block. */
export function tally(rows: readonly Row[]): Tally {
  const exec = rows.filter((r) => r.kind === "exec");
  const neu = rows.filter((r) => r.kind === "neutral" && !r.effect);
  const ran = exec.filter((r) => r.effect);
  return {
    generated: rows.length,
    executed: ran.length,
    allow: ran.filter((r) => r.verdict === "allow").length,
    ask: ran.filter((r) => r.verdict === "ask").length,
    bypass: ran.filter((r) => r.verdict !== "block").length,
    neutral: neu.length,
    neutralBlocked: neu.filter((r) => r.verdict === "block").length,
    neutralAsked: neu.filter((r) => r.verdict === "ask").length,
  };
}
