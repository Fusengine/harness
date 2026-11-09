/**
 * @module receipt-runners-parse-xcode
 * Pass/fail parser for `xcodebuild … test` output. Calibrated on real
 * captures: XCTest prints `Executed N tests, with M failure(s) (K unexpected)`
 * per suite/bundle, the LAST one being the `All tests` total, and ends with
 * `** TEST SUCCEEDED **` / `** TEST FAILED **`. xcbeautify forwards the
 * `Executed …` line verbatim (its `formatExecuted*` returns `wholeResult`) and
 * swift-testing's `Test run with N tests passed|failed after`, so the same
 * counters apply to a piped run.
 */
import { parseSwiftTest } from "./receipt-runners-parse";

/**
 * Counts from {@link parseSwiftTest} (XCTest `Executed` total + swift-testing
 * run lines), with `** TEST FAILED **` as a fail floor of 1 when the counted
 * failures are missing or zero (never lowers a real count). `** TEST
 * SUCCEEDED **` adds nothing: a zero-test run prints it too, so pass evidence
 * must come from a real count.
 */
export function parseXcodebuildTest(output: string): { pass?: number; fail?: number } {
  const counts = parseSwiftTest(output);
  if (/^\*\* TEST FAILED \*\*/m.test(output) && (counts.fail ?? 0) === 0) return { ...counts, fail: 1 };
  return counts;
}
