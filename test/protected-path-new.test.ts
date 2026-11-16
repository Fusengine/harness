/**
 * Guard-level regression for the receipt-store / HMAC-key protection (`~/.fuse-harness/state`, `~/.fuse-harness/.key`).
 * Rows come from adversarial challenger rounds: every READ (and look-alike) must stay allowed — no legacy heuristic is
 * inherited on these paths — and every real WRITE in a named category must be blocked.
 */
import { expect, test } from "bun:test";
import { protectedPathGuard } from "../src/policy/guards/protected-path";

const H = "~/.fuse-harness";
const K = `${H}/.key`, S = `${H}/state`, F = `${H}/state/ab/t.json`;

const reads: readonly string[] = [
  `cat ${K}`, `grep -rn mv ${S}`, `rg tee ${S}`, `grep -E "mv|cp" ${S}`, `cp -t /tmp ${F}`, `cp -rt /tmp/dst ${S}`, `install -Dt /tmp/dst ${K}`, `ln -st /tmp/dst ${K}`,
  `echo "cp a ${K}"`, `cp /tmp/a /tmp/b # ${S}`, `history | grep "cp .* ${K}"`, `touch -r ${K} /tmp/f`, `touch -cr ${K} /tmp/f`, `truncate -cr ${K} /tmp/f`, `ln -s ${K}`, `rsync ${S}/`,
  `rsync -a /tmp/src/ /tmp/dst --exclude-from ${S}/excl`, `rsync -a /tmp/src/ /tmp/dst --password-file ${K}`, `tar -C ${S} -czf /tmp/s.tgz .`, `tar -xf ${S}/a.tar -C /tmp/x`,
  `find /tmp/x -name a -exec cp ${K} {} \\;`, `find ${S} -name lock -exec rm -f /tmp/marker \\;`, `find ${S} -type f -exec touch -r {} /tmp/stamp \\;`,
  `sed -i -f ${S}/s.sed /tmp/out.txt`, `sed -n -e -i ${K}`, `command -v rm ${K}`, `sudo -l rm ${K}`, `echo then rm ${K}`, `[ -f ${K} ] && rm /tmp/x`, `time -p cat ${K}`,
  `cat <<'EOF' > /tmp/note\nrun: echo x > ${K}\nEOF`, `git commit -m "$(cat <<'EOF'\nfix: stop writing > ${F}\nEOF\n)"`, `git commit -m "He said \\"hi" -m "; rm ${K}"`,
  `truncate -o -r ${K} /tmp/x`, `shred --random-source ${K} /tmp/x`, `cat <<'EOF'\n$(rm ${K})\nEOF`, `find ${K} -newer ${K} -exec cat {} \\;`,
  `rsync -n -a /tmp/src/ ${S}/`, `rsync --dry-run -av /tmp/src/ ${S}/`, `find ${S} -type f -exec cp {} ~/bk{} \\;`, `echo \\$(rm ${K})`, `perl -ne print ${K} -i`, `tar -xOf /tmp/a.tar -C ${S}`,
  `cat <<EOF\n$(rm ${K})\nEOF`, // KNOWN LIMIT: substitutions inside UNQUOTED heredoc bodies are not analysed (scanning them over-blocked generated scripts)
  `rm /tmp/x\\ ${K}`, `cp ${K} $(mktemp)`, `cp ${K} $(( (n+1)*2 ))`, `echo x > ${H}/.keyboard`, `echo x > ${H}/.key.bak`, `echo x > ${H}/states/x`, `echo x > ${H}/stateful`,
];

const writes: readonly string[] = [
  `echo x > ${K}`, `echo x >> ${F}`, `echo x &> ${K}`, `cp /tmp/a ${K} 2>/dev/null`, `cp /tmp/a ${H}//state/x`, `mv /tmp/x ${H}/./state`, `mv ${S} /tmp/x`, `cp -t ${S} /tmp/a`, `cp -rt ${S} /tmp/a`,
  `ln -sf /tmp/x ${K}`, `rsync -a /tmp/x ${S}/`, `install /tmp/x ${K}`, `touch ${K}`, `truncate -s0 ${K}`, `rm -rf ${S}`, `rm -r ${S}`, `echo x | tee out.txt ${K}`, `tar -xf /tmp/t -C ${S}`,
  `unzip /tmp/z -d ${S}`, `dd if=/tmp/a of=${K}`, `sed -i s/a/b/ ${K}`, `sed -I .bak s/a/b/ ${K}`, `sed -i --expression=s/a/b/ ${K}`, `perl -pi.bak -e 1 ${K}`, `perl -0pi -e 1 ${K}`,
  `find /tmp -exec cp {} ${S} \\;`, `find ${S} -delete`, `find -x ${S} -delete`, `find ${S} -type f -exec rm {} +`, `echo a | xargs cp -t ${S}`, `xargs -J % cp % ${S}/ < /tmp/l`,
  `nice -n 10 rm ${K}`, `env -u HOME rm ${K}`, `{ cp /tmp/a ${K}; }`, `if true; then mv /tmp/a ${K}; fi`, `cp /tmp/a ${H}/'.key'`, `cp /tmp/a "${K}"`, `cp /tmp/a ${H}/\\.key`,
  `echo $(cp /tmp/a ${K})`, `cp /tmp/a $(dirname $(mktemp))/x ${K}`, `exec 3>${K}`,
  `find ${S} -type f -exec cat {} \\; -exec rm {} \\;`, `find ${S} -type f -exec cp {} {}.bak \\;`, `truncate -s 1 -o ${K}`, `rsync -a /tmp/x ${S}/`,
];

test("reads and look-alikes of the receipt store stay allowed", () => {
  const blocked = reads.filter((c) => protectedPathGuard({ tool: "Bash", command: c }) !== null);
  expect(blocked).toEqual([]);
});

test("real writes to the receipt store are blocked", () => {
  const allowed = writes.filter((c) => protectedPathGuard({ tool: "Bash", command: c }) === null);
  expect(allowed).toEqual([]);
});

test("Write/Edit: `//`, `/./`, `/../` and case variants cannot hide the store; look-alikes stay allowed", () => {
  for (const tool of ["Write", "Edit"]) {
    for (const p of [`${H}//state/x`, `${H}/./.key`, `/h//.fuse-harness//.key`, `${H}/state/../.key`, "/Users/u/.FUSE-HARNESS/.KEY", "/Users/John Smith/.fuse-harness/state/x"]) {
      expect(protectedPathGuard({ tool, filePath: p })?.kind, `${tool} ${p}`).toBe("block");
    }
    for (const p of [`${H}/.keyboard`, `${H}/.key.bak`, `${H}/states/x`, `${H}/cache/x`]) expect(protectedPathGuard({ tool, filePath: p }), `${tool} ${p}`).toBeNull();
  }
});
