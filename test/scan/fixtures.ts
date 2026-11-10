/**
 * @module test/scan/fixtures
 * Fixture tree specs for the scanner tests (generated at runtime).
 */
import { FAKE_AWS, type TreeSpec } from "./builders";

const JS_ALL = [
  "el.innerHTML = x;", "<p dangerouslySetInnerHTML={h}/>", "eval(code);", "new Function(b);",
  "const cp = require('child_process');", "spawn(c, { shell: true });", "const r = Math.random();",
  `const k = "${FAKE_AWS}";`,
].join("\n") + "\n";
const PHP_ALL = "<?php\nshell_exec($c);\neval($c);\nmysql_query($q);\nassert($a);\nsystem($d);\n";
const PY_ALL = "eval(x)\nexec(y)\nos.system(c)\nsubprocess.run(c, shell=True)\npickle.loads(d)\nrequests.get(u, verify=False)\n";
const SWIFT_ALL = 'UserDefaults.standard.set(pw, forKey: "password")\nlet u = "http://x.test"\nkSecAttrAccessibleAlways\n';

/** One tree per legacy language marker, plus the legacy edge cases. */
export const FIXTURES: Record<string, TreeSpec> = {
  "js-root": {
    "package.json": "{}", "a.js": JS_ALL, "sub/deep/b.js": JS_ALL + JS_ALL,
    "x.min.js": "var a=1;eval(a);\n", "node_modules/m/i.js": JS_ALL, "build/o.js": JS_ALL, "dist/o.js": JS_ALL,
    "multi.js": "eval(innerHTML = x); new Function(eval(y))\n", "crlf.js": "eval(a)\r\nel.innerHTML = b\r\n",
    "bin.js": new Uint8Array([101, 118, 97, 108, 40, 0, 10, 101, 118, 97, 108, 40, 120, 41, 10]),
    "long.js": "a".repeat(9000) + " eval(x) " + "b".repeat(2000) + " innerHTML = z\n",
    "big.js": "var a = 1;\n".repeat(120000) + "eval(x);\n",
    "app.ts": "eval(x)\n", "c.mjs": "eval(x)\n", "u.php": PHP_ALL,
  },
  "php-root": { "composer.json": "{}", "a.php": PHP_ALL, "views/b.blade.php": PHP_ALL, "vendor/v.php": PHP_ALL, "c.js": JS_ALL },
  "py-root": { "requirements.txt": "x", "a.py": PY_ALL, "pkg/b.py": PY_ALL, "venv-less/c.py": PY_ALL },
  "pyproject-root": { "pyproject.toml": "[x]", "a.py": PY_ALL },
  "swift-root": { "Package.swift": "//", "S/a.swift": SWIFT_ALL, "S/b.swift": SWIFT_ALL },
  "go-root": { "go.mod": "module x", "main.go": 'exec.Command("sh", "-c", cmd)\n' },
  "rust-root": { "Cargo.toml": "[p]", "src/main.rs": "unsafe { x }\n" },
  "unknown-root": { "a.js": JS_ALL, "b.py": PY_ALL },
  "empty": {},
};
