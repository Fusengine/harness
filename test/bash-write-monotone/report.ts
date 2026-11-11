/**
 * Prints the monotonicity numbers (run by hand: `bun test/bash-write-monotone/report.ts`).
 * `MONO_STRIDE=k` samples every k-th depth-2 / neutral case (default 5).
 */
import { standardCases, measure, tally, type Row } from "../helpers/monotone-measure";

const k = Number(process.env.MONO_STRIDE ?? "5");
const { exec0, exec1, exec2, neutral } = standardCases(k);
const t0 = Date.now();
const rows: Row[] = await measure([...exec0, ...exec1, ...exec2, ...neutral]);

const sections: Array<[string, Row[]]> = [
  ["atoms depth0 (deny+gap)", rows.filter((r) => r.kind === "exec" && r.depth === 0)],
  ["exec depth1 deny-atoms", rows.filter((r) => r.kind === "exec" && r.depth === 1 && !r.gap)],
  ["exec depth1 gap-atoms (cp/mv/install/ln)", rows.filter((r) => r.kind === "exec" && r.depth === 1 && r.gap)],
  ["exec depth2 deny-atoms", rows.filter((r) => r.kind === "exec" && r.depth === 2)],
  ["neutral (all depths)", rows.filter((r) => r.kind === "neutral")],
];
for (const [name, rs] of sections) console.log(name, JSON.stringify(tally(rs)));
const notExec = rows.filter((r) => r.kind === "exec" && !r.effect).map((r) => `${r.label}:${r.verdict}`);
console.log("exec cases WITHOUT effect (oracle says not executed):", notExec.length, notExec.slice(0, 30).join(" | "));
const bypass = rows.filter((r) => r.kind === "exec" && r.effect && r.verdict !== "block").map((r) => `${r.verdict}:${r.label}`);
await Bun.write(process.env.MONO_OUT ?? "/dev/stdout", `${bypass.join("\n")}\n`);
console.log("elapsed s", (Date.now() - t0) / 1000);
