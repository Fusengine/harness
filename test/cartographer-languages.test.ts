import { test, expect } from "bun:test";
import { descFromText, isDescribableSuffix } from "../src/policy/cartographer/describe";
import { COMMENT_SYNTAX } from "../src/policy/cartographer/comment-families";
import { SOURCE_LANGUAGE_EXTENSIONS, SOURCE_LANGUAGE_IDS } from "../src/util/source-languages";

const CASES: ReadonlyArray<readonly [ext: string, text: string, expected: string]> = [
  [".ts", "/** Module doc. */\nexport const a = 1;", "Module doc."],
  [".ts", "/**\n * @module util/x\n * More.\n */\nexport {};", "More."],
  [".js", "/* plain block */\n", "plain block"],
  [".mjs", "// esm comment\n", "esm comment"],
  [".swift", "/// Swift doc\nstruct A {}", "Swift doc"],
  [".vue", "<!-- Vue component -->\n<template></template>", "Vue component"],
  [".vue", "<script>\n// vue script comment\n</script>", "vue script comment"],
  [".svelte", "<script>\n/* svelte block */\n</script>", "svelte block"],
  [".astro", "---\n// astro frontmatter note\n---\n<div />", "astro frontmatter note"],
  [".php", "<?php\n// php line\n", "php line"],
  [".php", "<?php\n#[Attribute]\n# php hash\n", "php hash"],
  [".php", "<?php\n/**\n * Php doc block\n */\nclass A {}", "Php doc block"],
  [".py", "#!/usr/bin/env python\n# py hash\n", "py hash"],
  [".pyw", '"""Windows py doc"""\n', "Windows py doc"],
  [".rb", "# frozen_string_literal: true\n# Ruby model\nclass A; end", "Ruby model"],
  [".rake", "# Rake task\n", "Rake task"],
  [".java", "package a;\n/** Java class doc */\nclass A {}", "Java class doc"],
  [".kt", "// kotlin note\n", "kotlin note"],
  [".kts", "/* gradle script */\n", "gradle script"],
  [".cs", "/// <summary>\n/// C# service.\n/// </summary>\nclass A {}", "C# service."],
  [".go", "//go:build linux\n\n// Package foo does things.\npackage foo", "Package foo does things."],
  [".rs", "//! Crate level doc\nfn main() {}", "Crate level doc"],
  [".rs", "#![allow(dead_code)]\n/// Item doc\nfn f() {}", "Item doc"],
];

test.each(CASES)("described: %s", (ext, text, expected) => {
  expect(descFromText(ext, text, "")).toBe(expected);
});

test("every known source extension is describable, unknown ones are not", () => {
  for (const id of SOURCE_LANGUAGE_IDS) {
    expect(COMMENT_SYNTAX[id]).toBeDefined();
    for (const ext of SOURCE_LANGUAGE_EXTENSIONS[id]) expect(isDescribableSuffix(ext)).toBe(true);
  }
  for (const ext of [".md", ".TS"]) expect(isDescribableSuffix(ext)).toBe(ext === ".md" || ext === ".TS");
  for (const ext of [".pdf", ".png", ".json", ".xyz", ""]) expect(isDescribableSuffix(ext)).toBe(false);
});

test("no description when the comment is past the first 10 lines or absent", () => {
  expect(descFromText(".go", `${"\n".repeat(10)}// too late`, "")).toBe("");
  expect(descFromText(".java", "class A {}", "")).toBe("");
  expect(descFromText(".rs", "fn main() {}", "")).toBe("");
});

const GO_LICENSE = "// Copyright 2009 The Go Authors. All rights reserved.\n// Use of this source code is governed by a BSD-style\n// license that can be found in the LICENSE file.\n";
const APACHE = "/*\n * Licensed to the Apache Software Foundation (ASF) under one\n * or more contributor license agreements.\n */\n";

const NOISE: ReadonlyArray<readonly [ext: string, text: string, expected: string]> = [
  [".go", `${GO_LICENSE}\npackage foo`, ""],
  [".go", `${GO_LICENSE}\n// Package foo does things.\npackage foo`, "Package foo does things."],
  [".java", `${APACHE}package a;\n/** Real class doc */\nclass A {}`, "Real class doc"],
  [".java", `${APACHE}package a;\nclass A {}`, ""],
  [".kt", "/*\n * Copyright 2020 Square, Inc.\n */\npackage a", ""],
  [".cs", "// Licensed to the .NET Foundation under one or more agreements.\n// The .NET Foundation licenses this file to you under the MIT license.\nnamespace A;", ""],
  [".php", "<?php\n\n/*\n * This file is part of the Symfony package.\n *\n * (c) Fabien\n */\nnamespace A;", ""],
  [".rs", "// SPDX-License-Identifier: MIT\n// Real rust note\n", "Real rust note"],
  [".js", "/* eslint-disable no-console */\nconsole.log(1)", ""],
  [".mjs", "/* istanbul ignore file */\n// real note\n", "real note"],
  [".mjs", "// @ts-nocheck\n// helpers for x\n", "helpers for x"],
  [".mjs", "/* global window */\n", ""],
  [".mjs", "class A {\n  #count = 0;\n}", ""],
  [".mts", "#count = 0;\n", ""],
  [".mjs", "/*\n * ==========\n * Motion helpers\n * ==========\n */\n", "Motion helpers"],
  [".mjs", "/* ═════════ */\n// ------\n// Real prose\n", "Real prose"],
  [".go", "// ********\n// Package x does y.\npackage x", "Package x does y."],
  [".rb", "# ------\n# Ruby prose\n", "Ruby prose"],
  [".pyw", "# Copyright 2020 X\n# All rights reserved\n\n# Real note\n", "Real note"],
];

test.each(NOISE)("no misleading description: %s", (ext, text, expected) => {
  expect(descFromText(ext, text, "")).toBe(expected);
});

test("known pre-existing quirks of the 7 legacy extensions stay byte-identical", () => {
  expect(descFromText(".ts", "// Copyright 2020 Acme\nexport {};", "")).toBe("Copyright 2020 Acme");
  expect(descFromText(".js", "class A {\n  #count = 0;\n}", "")).toBe("count = 0;");
  expect(descFromText(".swift", "// Licensed under MIT\n", "")).toBe("Licensed under MIT");
  expect(descFromText(".py", "# Copyright X\n", "")).toBe("Copyright X");
});

test("legacy line comments win over later block comments (output stays identical)", () => {
  expect(descFromText(".ts", "/** doc */\n// line wins\n", "")).toBe("line wins");
});
