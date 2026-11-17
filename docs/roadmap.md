# Harness roadmap

Status: harness frozen after 0.1.125 (2026-11-17). Nothing here starts without an explicit owner request.

| # | Item | Problem | Fix idea | Risk |
|---|------|---------|----------|------|
| 1 | Flaky perf test | `test/bash-write-data-contexts.test.ts` case (e) measures a 5 ms limit with one wall-clock sample; failed Publish 44054054330 attempt 1 at 6.74 ms | Take the best of 3–5 samples, keep the 5 ms limit and inputs | None (test only) |
| 2 | SKIP_DIRS on absolute path | `src/policy/trivial-edits.ts:15` + `src/runtime/gate-apex.ts:77` match on the absolute path: a parent folder like `rebuild` or `distributed-sys` disables APEX for the whole project | Match path segments relative to the project root | New blocks for affected users (correct ones) |
| 3 | `~/.fuse-harness` parent dir | `mv ~/.fuse-harness /tmp/x` is allowed and `rm -rf ~/.fuse-harness` is only an ask; both take the state and HMAC key | Add the `.fuse-harness` dir itself to `NEW_PATH_RES` as a write/delete target | New block on that exact path |
