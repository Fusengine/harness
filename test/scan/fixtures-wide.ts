/**
 * @module test/scan/fixtures-wide
 * Wide-coverage fixture specs (TS app, Next + Laravel monorepo, Go, Rust,
 * per-extension matrix). Generated at runtime only.
 */
import { FAKE_AWS, type TreeSpec } from "./builders";

/** One vulnerable line per extension: [file extension, line, expected language, expected rule id]. */
export const EXT_MATRIX: readonly (readonly [string, string, string, string])[] = [
  ["js", "el.innerHTML = x;", "javascript", "js.xss.innerhtml-dynamic"],
  ["jsx", "el.innerHTML = x;", "javascript", "js.xss.innerhtml-dynamic"],
  ["mjs", "el.innerHTML = x;", "javascript", "js.xss.innerhtml-dynamic"],
  ["cjs", "el.innerHTML = x;", "javascript", "js.xss.innerhtml-dynamic"],
  ["ts", "el.innerHTML = x;", "typescript", "js.xss.innerhtml-dynamic"],
  ["tsx", "el.innerHTML = x;", "typescript", "js.xss.innerhtml-dynamic"],
  ["mts", "el.innerHTML = x;", "typescript", "js.xss.innerhtml-dynamic"],
  ["cts", "el.innerHTML = x;", "typescript", "js.xss.innerhtml-dynamic"],
  ["vue", '<div v-html="body"></div>', "vue", "js.xss.framework-html"],
  ["svelte", "{@html post.body}", "svelte", "js.xss.framework-html"],
  ["astro", "<div set:html={body} />", "astro", "js.xss.framework-html"],
  ["php", "<?php shell_exec($c);", "php", "php.cmd.exec-family"],
  ["py", "pickle.loads(d)", "python", "py.deser.pickle-family"],
  ["swift", "CC_MD5(data, len, &digest)", "swift", "swift.crypto.cc-md5"],
  ["go", 'exec.Command("sh", "-c", cmd)', "go", "go.cmd.exec-shell"],
  ["rs", "unsafe { x }", "rust", "rust.unsafe.block"],
  ["rb", "eval(params[:c])", "ruby", "rb.exec.eval"],
  ["java", 'Runtime.getRuntime().exec("ls " + d);', "java", "jvm.cmd.runtime-exec"],
  ["kt", 'Runtime.getRuntime().exec("ls " + d)', "kotlin", "jvm.cmd.runtime-exec"],
  ["cs", "var f = new BinaryFormatter();", "csharp", "cs.deser.unsafe"],
];

const TSX_BAD = "export const C = () => <div dangerouslySetInnerHTML={{ __html: h }} />;\n";

/** TS app: every JS/TS extension, a declaration file and an excluded dependency. */
export const TS_APP: TreeSpec = {
  "package.json": "{}", "tsconfig.json": "{}",
  "src/a.ts": "el.innerHTML = x;\n", "src/b.tsx": TSX_BAD, "src/c.mts": "eval(x);\n", "src/d.cts": "eval(x);\n",
  "src/e.jsx": TSX_BAD, "src/f.mjs": "eval(x);\n", "src/g.cjs": "eval(x);\n", "src/h.js": "eval(x);\n",
  "src/i.ts": "eval(x);\n", "src/types.d.ts": "eval(x);\n", "node_modules/m/i.ts": "eval(x);\n",
};

/** Next.js + Laravel + UI package monorepo; the root has NO PHP marker. */
export const MONOREPO: TreeSpec = {
  "package.json": "{}",
  "apps/web/package.json": "{}", "apps/web/next.config.mjs": "export default {};\n",
  "apps/web/app/page.tsx": TSX_BAD, "apps/web/lib/db.ts": "const sessionToken = Math.random();\n",
  "apps/api/composer.json": "{}", "apps/api/artisan": "#!/usr/bin/env php\n",
  "apps/api/app/Http/C.php": "<?php shell_exec($c);\n", "apps/api/resources/views/x.blade.php": "<?php eval($c); ?>\n",
  "apps/api/.env": `AWS_KEY=${FAKE_AWS}\n`, "apps/api/vendor/v/V.php": "<?php eval($c);\n",
  "apps/api/storage/framework/views/c.php": "<?php eval($c);\n",
  "packages/ui/a.vue": '<div v-html="b"></div>\n', "packages/ui/b.svelte": "{@html b}\n", "packages/ui/c.astro": "<p set:html={b} />\n",
};

/** Go service. */
export const GO_SVC: TreeSpec = {
  "go.mod": "module x\n", "main.go": 'package main\nfunc f() { exec.Command("sh", "-c", cmd) }\n',
  "internal/x.go": 'import "crypto/md5"\n', "vendor/z.go": 'import "crypto/md5"\n',
};

/** Rust crate with a build dir that must be excluded thanks to the Cargo.toml sibling. */
export const RUST_CRATE: TreeSpec = {
  "Cargo.toml": "[package]\n", "src/main.rs": "fn main() { unsafe { f() } }\n", "target/debug/y.rs": "fn y() { unsafe { f() } }\n",
};
