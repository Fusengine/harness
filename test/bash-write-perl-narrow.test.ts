import { test, expect } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { CMD } from "../src/policy/guards/bash-command-anchor";

/**
 * Final minimal window: the perl in-place rule differs from ae977a9 in exactly two
 * cases — (A) a pure-read `-n/-l/-a/-F/-0/-w/-e/-E` program, (B) the owner's
 * `alarm N; exec @ARGV` timeout idiom with a bare agent-CLI child. Everything else
 * is ae977a9's verdict (the legacy regex), byte for byte.
 */

const LEGACY = new RegExp(`${CMD}perl\\b[^|]*\\s-[pi]i?\\b`);
const guard = (command: string) => bashWriteGuard({ tool: "Bash", command });
const inPlaceBlock = (command: string): boolean => {
  const r = guard(command);
  return r?.kind === "block" && r.reason.startsWith("perl in-place edit");
};
const parity = (commands: readonly string[], label: string) => {
  for (const command of commands) {
    test(`${label}: ${JSON.stringify(command)}`, () => {
      expect(inPlaceBlock(command)).toBe(LEGACY.test(command));
    });
  }
};

parity([
  "perl -e 1; perl5.34 -pi -e s/a/b/ x.ts", "perl -e 1 && perl5.34 -pi -e s/a/b/ x.ts", "perl -e 1 & perl5.34 -pi -e s/a/b/ x.ts",
  "perl -e 1\nperl5.34 -pi -e s/a/b/ x.ts", "/usr/bin/perl -pi -e s/a/b/ x.ts", '"perl" -pi -e s/a/b/ x.ts', "'perl' -pi -e s/a/b/ x.ts",
  "p''erl -pi -e s/a/b/ x.ts", "env -u FOO perl -pi -e s/a/b/ x.ts", "env -S 'perl -pi -e s/a/b/' x.ts", "xargs -I F perl -pi -e s/a/b/ F < list.txt",
  "sh -c 'perl -pi -e s/a/b/ x.ts'", "{ perl -pi -e s/a/b/ x.ts; }", "! perl -pi -e s/a/b/ x.ts", "X='a b' perl -pi -e s/a/b/ x.ts",
  "if true; then perl -pi -e s/a/b/ x.ts; fi", "builtin command perl -pi -e s/a/b/ x.ts", "and perl -pi -e s/a/b/ x.ts", "not perl -pi -e s/a/b/ x.ts",
  "=perl -pi -e s/a/b/ x.ts", "perl script.pl -i x.ts", "perl -p -- -i x.ts", "perl -- -i", "perl - -pi", "perl -s script.pl -i", "perl -p",
  "perl -le 'print 1' ; ls -p", "perl -e 1 && claude -p hi", "perl -pi -e 's/a/b/' f.ts", "perl -i.bak -pe 's/a/b/' f.ts", "perl -0pi -e 1 f.ts",
  "perl -wi -e 1 f.ts", "perl -E 'say 1' -p", "perl -Ci -pe 1 f.ts", "perl -e 1 -pi f.ts", "perl -pe 2>/dev/null 's/a/b/' -i src/x.ts",
  "perl $'\\U2d'i -p -e 's/a/b/' f.ts", "perl -e '1;#\\' ' -pi f.ts ' 'b\\'", "perl -pi$BAK -e 's/a/b/' src/x.ts", "perl -dpi -e 1 f", "perl -Vpi -e 1 f",
  "perl -e 'alarm 120; exec @ARGV' perl -pi -e s/a/b/ x.txt", "perl -e 'exec @ARGV' perl -i -pe s/a/b/ x.txt",
], "outside A/B -> ae977a9");

// Round 6: programs that run commands / set $^I must keep ae977a9's verdict (block or ask), never allow.
parity([
  `perl -e 'readpipe "@ARGV"' sed -i.bak s/a/b/ f.ts`,
  `perl -MIPC::Open3 -e 'open3(undef,undef,undef,@ARGV); wait' sed -i.bak s/a/b/ f.ts`,
  `perl -MIPC::Open2 -e 'open2(my $o, my $i, @ARGV)' sed -i.bak s/a/b/ f.ts`,
  `perl -e 'readpipe "sed -i.bak s/a/b/ f.ts"'`,
  `perl -e 'qx/sed -i.bak s,a,b, f.ts/'`,
  `perl -pe 'BEGIN{$^I=""} s/ -i//' f.ts`,
  `perl -pe 'BEGIN{$^I=""} s/a/b/' f.ts -p`,
  `perl -ne 'BEGIN{$^I=".bak"} s/a/b/; print' f.ts -i`,
  `perl -e 'require "./x.pl"' f.ts -i`,
  `perl -e 'do "./x.pl"' f.ts -i`,
  `perl -e 'system "sed -i.bak s/a/b/ f.txt"'`,
  `perl -e 'alarm 5; exec @ARGV' sed -i s/a/b/ src/x.ts`,
  `perl -e 'alarm 5; exec @ARGV' true`,
  `perl -e 'alarm 60; exec @ARGV' python3 -c 'print(1)'`,
  `perl -e 'alarm 60; exec @ARGV' patch --dry-run -p1 x.diff`,
  `perl -e 'alarm 60; exec @ARGV' patch -p1 --dry-run`,
  `perl -e 'alarm 60; exec @ARGV' sh -c 'sed -i s/a/b/ f.ts'`,
  `perl -e 'alarm 60; exec @ARGV' ./claude -p x`,
  `perl -e 'alarm 60; exec @ARGV' gemini -p x`,
  `perl -e 'alarm 60; exec @ARGV' /usr/bin/codex -p x`,
  `perl -e 'alarm 60; exec @ARGV' cursor-agent2 -p x`,
  `perl -e 'alarm 60; exec @ARGV; print 1' claude -p x`,
], "round-6 -> ae977a9");

test("round 6: never an allow for a command that runs a command or sets $^I", () => {
  expect(guard(`perl -e 'readpipe "@ARGV"' sed -i.bak s/a/b/ f.ts`)?.kind).toBe("block");
  expect(guard(`perl -e 'system "sed -i.bak s/a/b/ f.txt"'`)).not.toBeNull();
  expect(guard(`perl -e 'alarm 60; exec @ARGV' patch --dry-run -p1 x.diff`)?.kind).toBe("ask");
  expect(guard(`perl -e 'alarm 60; exec @ARGV' python3 -c 'print(1)'`)?.kind).toBe("ask");
});

// (B) the owner's timeout idiom with a bare agent CLI: the in-place rule does not fire.
test("(B) timeout idiom with an agent CLI is not an in-place block (exec ask stays)", () => {
  for (const child of ["claude", "codex", "kimi", "cursor", "cursor-agent"]) {
    for (const command of [`perl -e 'alarm 120; exec @ARGV' ${child} -p "x"`, `perl -e 'exec @ARGV' ${child} -p -i`, `perl -E 'alarm 5; exec @ARGV;' ${child} -p x`]) {
      expect(inPlaceBlock(command)).toBe(false);
      expect(guard(command)?.kind).toBe("ask");
    }
  }
});

// (A) pure reads: switches only in n l a F 0 w E e, programs without any command/in-place construct.
const READS: readonly string[] = [
  "perl -ne 'print if /TODO/' src/api-items.ts",
  "perl -lane 'print $F[0]' data-index.csv",
  "perl -nle 'print length' my-file.ts",
  "perl -0777 -ne 'print length' f.ts",
  "perl -F: -lane 'print $F[1]' data.csv",
  "perl -nle 'print length' x -p",
  "perl -ne 'print' notes -pi.txt",
  "perl -ne 'print' x -i",
  "perl -lane 'print $F[0]' f.ts -p",
  "perl -e 'print \"a -pi b\"' f.ts",
  "perl -e -i f.ts",
  "perl -wne 'print if /x/' f -pi",
];
for (const command of READS) {
  test(`(A) pure read: ${command}`, () => {
    expect(inPlaceBlock(command)).toBe(false);
  });
}

// Anything A excludes keeps ae977a9's verdict even with -p/-i-looking trailing words.
parity([
  "perl -MJSON::PP -e 'print 1' data.json -p", "perl -pe 1 f -p",
  "perl -ne 'open F, \"<x\"' f -p", "perl -ne 'print > x' f -p", "perl -ne 'eval 1' f -p", "perl -ne 'do 1' f -p",
  "perl -ne 'print { $fh } 1' f -p", "perl -ne 'unlink $_' f -p", "perl -ne 'rename $_, 1' f -p", "perl -ne 'fork' f -p",
  "perl -ne 'sysopen F, $_, 1' f -p", "perl -ne 'syscall 1' f -p", "perl -ne 'use English; $INPLACE_EDIT=1' f -p",
  "perl -ne 'print `ls`' f -p", "perl -xne 'print' f -p", "perl -Sne 'print' f -p", "perl -dne 'print' f -p", "perl -Mstrict -ne 'print' f -p",
  "perl -ne 'print' -- f -p", "perl -ne 'print' - -p", "perl -ne 'print' f > out -p", "perl -ne 'print' $X -p", "perl -ne \"print\" f; ls -p",
], "A excluded -> ae977a9");
