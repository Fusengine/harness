/**
 * `xcodebuild … test` runner — output excerpts are REAL captures (Xcode on
 * macOS, SwiftPM package, `-destination 'platform=macOS'`).
 */
import { test, expect } from "bun:test";
import { classifyReceipt } from "../src/tracking/receipts";

const T = 1_000_000_000_000;
const CMD = "xcodebuild test -scheme Lib -destination 'platform=macOS'";

const PASS = [
  "Test Suite 'All tests' started at 2026-11-09 20:45:15.360.",
  "Test Suite 'T' passed at 2026-11-09 20:45:15.363.",
  "\t Executed 2 tests, with 0 failures (0 unexpected) in 0.001 (0.002) seconds",
  "Test Suite 'LibTests.xctest' passed at 2026-11-09 20:45:15.363.",
  "\t Executed 2 tests, with 0 failures (0 unexpected) in 0.001 (0.002) seconds",
  "Test Suite 'All tests' passed at 2026-11-09 20:45:15.363.",
  "\t Executed 2 tests, with 0 failures (0 unexpected) in 0.001 (0.003) seconds",
  "",
  "** TEST SUCCEEDED **",
].join("\n");

const FAIL = [
  "Test Case '-[LibTests.T testB]' failed (0.436 seconds).",
  "Test Suite 'All tests' failed at 2026-11-09 20:45:54.449.",
  "\t Executed 2 tests, with 1 failure (0 unexpected) in 0.437 (0.439) seconds",
  "",
  "Failing tests:",
  "\tT.testB()",
  "",
  "** TEST FAILED **",
].join("\n");

test("xcodebuild test: real green capture parses pass 2 / fail 0", () => {
  expect(classifyReceipt(CMD, PASS, 0, T)).toMatchObject({ kind: "test", tool: "xcodebuild test", pass: 2, fail: 0 });
});

test("xcodebuild test: real red capture (singular 'failure') parses fail 1", () => {
  expect(classifyReceipt(CMD, FAIL, 65, T)).toMatchObject({ tool: "xcodebuild test", pass: 1, fail: 1 });
});

test("xcodebuild test: '** TEST FAILED **' alone is a fail floor", () => {
  expect(classifyReceipt(CMD, "** TEST FAILED **", 65, T)).toMatchObject({ tool: "xcodebuild test", fail: 1 });
});

test("xcodebuild test piped through xcbeautify keeps the verbatim Executed line", () => {
  const piped = `${CMD} | xcbeautify`;
  expect(classifyReceipt(piped, PASS, 0, T)).toMatchObject({ tool: "xcodebuild test", pass: 2, fail: 0 });
  expect(classifyReceipt(`set -o pipefail; ${piped}`, FAIL, 65, T)).toMatchObject({ tool: "xcodebuild test", fail: 1 });
});

test("xcodebuild: action variants and leading options still resolve", () => {
  expect(classifyReceipt("xcodebuild -quiet test -scheme Lib", PASS, 0, T)).toMatchObject({ tool: "xcodebuild test" });
  expect(classifyReceipt("xcodebuild -workspace A.xcworkspace -scheme A test-without-building", PASS, 0, T)).toMatchObject({
    tool: "xcodebuild test",
  });
});

test("xcodebuild build / showBuildSettings / build-for-testing / -only-testing produce no test receipt", () => {
  expect(classifyReceipt("xcodebuild build -scheme Lib", "** BUILD SUCCEEDED **", 0, T)).toBeNull();
  expect(classifyReceipt("xcodebuild -scheme Lib build", "** BUILD SUCCEEDED **", 0, T)).toBeNull();
  expect(classifyReceipt("xcodebuild -showBuildSettings -scheme Lib", "Build settings for action build", 0, T)).toBeNull();
  expect(classifyReceipt("xcodebuild build-for-testing -scheme Lib", "** TEST BUILD SUCCEEDED **", 0, T)).toBeNull();
  expect(classifyReceipt("xcodebuild -scheme Lib -only-testing:LibTests/T build", "** BUILD SUCCEEDED **", 0, T)).toBeNull();
});

test("xcodebuild test: a quoted mention or an earlier segment is no receipt", () => {
  expect(classifyReceipt('git commit -m "xcodebuild test -scheme Lib"', PASS, 0, T)).toBeNull();
  expect(classifyReceipt("xcodebuild test -scheme Lib && git commit -m x", PASS, 0, T)).toBeNull();
});

test("xcodebuild regex stays linear on adversarial flag/action chains", () => {
  const t0 = performance.now();
  classifyReceipt("xcodebuild " + "-a build ".repeat(1500) + "zz", "", 0, T);
  classifyReceipt("xcodebuild " + "-a b ".repeat(3000) + "-c", "", 0, T);
  expect(performance.now() - t0).toBeLessThan(250);
});

test("xcodebuild test: zero-test run is not positive evidence", () => {
  const r = classifyReceipt(CMD, "\t Executed 0 tests, with 0 failures (0 unexpected) in 0.0 (0.0) seconds\n** TEST SUCCEEDED **", 0, T);
  expect(r).toMatchObject({ tool: "xcodebuild test", pass: 0 });
});
