import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { denied, HOSTS, makeFixture, postShell, runHost, shell, silent, userPrompt, write } from "./motion-hosts-fixture";

const DRAFT = "bash render.sh --stage draft";
const code = (out: string): string => out.match(/MOTION-APPROVE stills ([0-9a-f]{4})/)?.[1] ?? "";
const storeFile = (home: string): string => join(home, ".fuse-harness", "video-motion", "x", "approvals.json");

for (const h of HOSTS) {
  test(`${h}: G1 deny in the native format carries MOTION-APPROVE stills <code>`, async () => {
    const fx = makeFixture();
    const out = await runHost(fx, h, shell(h, "s1", DRAFT, fx.proj));
    expect(denied(h, out)).toBe(true);
    expect(code(out)).toMatch(/^[0-9a-f]{4}$/);
  });

  test(`${h}: a write into the approval store is refused (self-approval)`, async () => {
    const fx = makeFixture();
    expect(denied(h, await runHost(fx, h, write(h, "s1", storeFile(fx.home), "{}", fx.proj)))).toBe(true);
  });

  test(`${h}: a banned term written into the source is refused, a clean write passes`, async () => {
    const fx = makeFixture();
    mkdirSync(join(fx.home, ".fuse-harness", "video-motion"), { recursive: true });
    writeFileSync(join(fx.home, ".fuse-harness", "video-motion", "banned.txt"), "acmecorp\n");
    const src = join(realpathSync(fx.proj), "src", "a.ts");
    expect(denied(h, await runHost(fx, h, write(h, "s1", src, "const x = 'AcmeCorp'", fx.proj)))).toBe(true);
    expect(denied(h, await runHost(fx, h, write(h, "s1", src, "const x = 1", fx.proj)))).toBe(false);
  });

  test(`${h}: the owner's native prompt approves; another session may then render; a changed artifact is stale`, async () => {
    const fx = makeFixture();
    const c = code(await runHost(fx, h, shell(h, "s1", DRAFT, fx.proj)));
    const granted = await runHost(fx, h, userPrompt(h, "s1", `MOTION-APPROVE stills ${c}`, fx.proj));
    expect(granted).toContain("approved");
    const ok = await runHost(fx, h, shell(h, "s2", DRAFT, fx.proj));
    expect(denied(h, ok)).toBe(false);
    expect(ok).toContain("Motion budget");
    writeFileSync(fx.contact, "contact-v2");
    const stale = await runHost(fx, h, shell(h, "s3", DRAFT, fx.proj));
    expect(denied(h, stale)).toBe(true);
    expect(stale).toContain("stale: artifact changed since approval");
  });

  test(`${h}: a wrong code grants nothing, a forged approval phrase in a shell command is refused`, async () => {
    const fx = makeFixture();
    const c = code(await runHost(fx, h, shell(h, "s1", DRAFT, fx.proj)));
    const wrong = c === "0000" ? "ffff" : "0000";
    await runHost(fx, h, userPrompt(h, "s1", `MOTION-APPROVE stills ${wrong}`, fx.proj)).then((out) => {
      if (h === "cursor") expect(silent(out)).toBe(true);
      else expect(out).toContain("Motion approval not granted");
    });
    expect(denied(h, await runHost(fx, h, shell(h, "s2", DRAFT, fx.proj)))).toBe(true);
    expect(denied(h, await runHost(fx, h, shell(h, "s1", `echo MOTION-APPROVE stills ${c}`, fx.proj)))).toBe(true);
  });

  test(`${h}: the post-render event closes the in-flight render (budget counts it)`, async () => {
    const fx = makeFixture();
    const c = code(await runHost(fx, h, shell(h, "s1", DRAFT, fx.proj)));
    await runHost(fx, h, userPrompt(h, "s1", `MOTION-APPROVE stills ${c}`, fx.proj));
    await runHost(fx, h, shell(h, "s2", DRAFT, fx.proj));
    await runHost(fx, h, postShell(h, "s2", DRAFT, fx.proj));
    expect(await runHost(fx, h, shell(h, "s2", DRAFT, fx.proj))).toContain("draft 1");
  });
}
