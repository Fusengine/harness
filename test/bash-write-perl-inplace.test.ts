import { test, expect } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { CMD } from "../src/policy/guards/bash-command-anchor";

/**
 * Generated parity corpus: every perl form with an in-place switch, an expansion,
 * a redirect, a shifted quote or a non-ASCII dash must get EXACTLY ae977a9's
 * verdict (the legacy regex). Only the two exempt cases in
 * bash-write-perl-narrow.test.ts may differ.
 */

const LEGACY = new RegExp(`${CMD}perl\\b[^|]*\\s-[pi]i?\\b`);
const inPlaceBlock = (command: string): boolean => {
  const r = bashWriteGuard({ tool: "Bash", command });
  return r?.kind === "block" && r.reason.startsWith("perl in-place edit");
};

const corpus: string[] = [];
const REDIRECTS = ["2>/dev/null", ">f", "<f", "2>&1", "&>f", ">|f", "<<<x", "3>&-", ">/dev/null", "> f", "2> f"];
for (const r of REDIRECTS) {
  corpus.push(`perl -pe ${r} 's/a/b/' -i src/x.ts`, `perl ${r} -pe 's/a/b/' -i src/x.ts`, `perl -p ${r} -i -e 1 src/x.ts`,
    `perl -e 1 ${r} -i src/x.ts`, `perl -e 1 -pi ${r} src/x.ts`, `perl -e 1 -0777 -i ${r} src/x.ts`);
}
for (const tail of ["-i", "-pi", "-0777 -i", "-l -i", "-x -i", "-i.bak", "-w -i"]) {
  corpus.push(`perl -e 's/a/b/' ${tail} src/x.ts`, `perl -pe 's/a/b/' ${tail} src/x.ts`, `perl -ne 'print' ${tail} src/x.ts`);
}
const HEADS = [
  "$'\\U2d'i -p", "$'\\x2d'pi", "$'\\055'pi", "$'\\u2d'pi", "$'\\cI'", "-w$'\\e'", "$\"-pi\"", "\\-pi", "-\\pi", "-p\\i", "‐pi", "−pi",
  "-pi$BAK", "-pi${BAK}", "-pi\"$SUF\"", "-i\"$B\"", "-i${EXT:-}", "-p$X", "-p$(echo i)", "-p`echo i`", "-p$'i'", "-dpi", "-Vpi", "-Dpi", "-Ci",
  "-0pi", "-ni", "-wpi", "-lpi", "'-pi'", "\"-pi\"", "-p\"i\"", "${X} -pi", "\"$@\" -pi", "$F -pi", "-{p,i}", "(echo -pi)", "\\x2dpi",
];
for (const head of HEADS) {
  for (const tail of ["", " -p", " -i", " -pi"]) {
    corpus.push(`perl ${head} -e 's/a/b/' f.ts${tail}`, `perl -e 1 ${head} f.ts${tail}`, `perl -pe 's/a/b/' ${head} f.ts${tail}`);
  }
}
for (const sw of ["-pi", "-i", "-0pi", "-i.bak", "-0777 -i", "-wpi"]) {
  corpus.push(
    `perl -e '1;#\\' ' ${sw} f.ts ' 'b\\'`, `perl -e '1;#\\\\' ' ${sw} f.ts ' 'b\\\\'`, `perl -e 'a\\'b' ${sw} f.ts ' 'c'`,
    `perl -e 'one\ntwo' ${sw} f.ts`, `perl -e 'a!b' ${sw} f.ts`, `perl -e "a!b" ${sw} f.ts`, `perl -e "a\nb" ${sw} f.ts`,
    `echo 'q\\' ; perl -e 1 ${sw} f.ts`,
  );
}
corpus.push("perl > > -pi src/x.ts", "perl" + " > ".repeat(100_000), "perl" + " >x".repeat(100_000) + " -pi f");

for (const command of corpus) {
  test(`parity with ae977a9: ${JSON.stringify(command.slice(0, 120))}`, () => {
    expect(inPlaceBlock(command)).toBe(LEGACY.test(command));
  });
}
