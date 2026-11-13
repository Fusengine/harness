# policy — evaluation & guards

`import { evaluate, evaluateFileSize, detectProjectType, detectFramework } from "@fusengine/harness/policy";`

The harness-agnostic decision layer. Pure functions — no I/O, no harness coupling.

## `evaluate(ctx): PolicyResult`

The unified entry point (`src/policy/evaluate.ts`). Adapters call this and
translate the `prompt` it returns; it runs only the **stateless** checks — the
stateful APEX gates (freshness, doc-consulted, solid-read, brainstorm) need
session state and only run through `runtime`'s `gate()`, see
[runtime.md](./runtime.md) and [guards.md](./guards.md).

```ts
interface PolicyContext {
  tool: string;          // "Write" | "Edit" | "Bash" | ...
  filePath?: string;
  content?: string;
  command?: string;      // for Bash tools
  maxLines?: number;     // override SOLID limit
  agentType?: string;    // "Explore"/"Plan" exempts the file-size check
  existingLines?: number; // on-disk line count, for an Edit's file-size judgment
}
interface PolicyResult {
  decision: "allow" | "deny";
  message: string | null;
  prompt?: Prompt;       // the portable { kind, title, reason, actions? }
  meta?: Record<string, unknown>;
}
```

Current policies, in order (`evaluate.ts`):
1. **guard chain** (`runGuards`, see [guards.md](./guards.md)) — git-flow,
   confirm-relay, security, protected-path, bash-write, interface-separation,
   install, opaque-shell → `deny`
   (block or ask) on the first match. Fail-closed: a guard that throws is
   treated as a block.
2. **git guard** — `command` matching `GIT_BLOCKED` → block;
   `GIT_ASK` → ask. Both are skipped for `RALPH_SAFE` commands when
   `RALPH_MODE` is on (destructive commands are never in that safe list).
3. **file-size (SOLID)** — a code `filePath` scoped by `isFileSizeScoped`
   (`.css` excluded) whose line count exceeds `FUSE_SOLID_MAX_LINES` → `deny`
   (with `meta.framework`, `meta.lines`, `meta.max`). A `Write` judges its new
   content; an `Edit` judges the existing on-disk file
   (`ctx.existingLines`). `Explore`/`Plan` agents are exempt.
4. otherwise `allow`.

```ts
const r = evaluate({ tool: "Write", filePath: "src/big.ts", content });
if (r.decision === "deny") report(r.prompt?.reason ?? r.message);
```

## Building blocks

| Export | Description |
|--------|-------------|
| `evaluateFileSize(lines, max?)` | `{ ok, lines, max, message }` against the SOLID limit |
| `countLines(content)` | line count (empty = 0) |
| `detectProjectType(dir)` | framework from config files on disk (19 types) |
| `detectFramework(path, content)` | framework from extension + content patterns |
| `DEV_KEYWORDS`, `isApexCommand(prompt)` | dev-task / `/apex` detection |
| `GIT_BLOCKED`, `GIT_ASK`, `SYSTEM_INSTALL`, `PROJECT_INSTALL` | `RegExp[]` guard data (verbatim from the fusengine guards) |
| `matchPatterns(cmd, patterns)` | `true` if any pattern matches |

> Faithful note: `GIT_BLOCKED`'s `git push.*--force` also matches
> `--force-with-lease` — preserved from the source guard.
