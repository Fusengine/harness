import { test, expect, describe } from "bun:test";
import { classifyFinalMessage } from "../src/policy/lead-guards/outcome-only";

const relayLike = (t: string): boolean => classifyFinalMessage(t).relayLike;

describe("outcome guard: structure only, a status narration without marker is a relay", () => {
  test("progress narration", () => {
    expect(relayLike("Kimi finit encore ses derniers points, et l'analyse KrazMail tourne toujours.")).toBe(true);
  });
  test("agent anchor ids are not a commit hash", () => {
    expect(relayLike("Le portage avance, voir [Codex](#local_92f4d473-04b1-46e2-a542-5e098d1ea900) : il écrit encore.")).toBe(true);
  });
  test("a branch name is not a file path", () => {
    expect(relayLike("Kimi : sniper vérifie, puis le commit WIP suivra sur la branche fix/kimi-mcp-json.")).toBe(true);
  });
  test("a URL inside an inline code span is an instruction, not a delivered result", () => {
    expect(relayLike("Kimi remplace la commande par `/plugins install https://github.com/fusengine/kimi-code` dans chaque README.")).toBe(true);
  });
  test("very short acknowledgements and stand-by words are never relays", () => {
    expect(relayLike("waiting")).toBe(false);
    expect(relayLike("OK.")).toBe(false);
    expect(relayLike("   ")).toBe(false);
  });
  test("adversarial 200 KB inputs are classified instantly and never blocked", () => {
    for (const t of ["\n".repeat(200_000), " ".repeat(200_000), "„".repeat(200_000), "](#".repeat(70_000), "1".repeat(200_000)]) {
      // Structural proof instead of a wall-clock bound: the scan is skipped, so no regex runs on the input.
      expect(classifyFinalMessage(t)).toEqual({ statusOnly: false, markers: ["long-message"], relayLike: false });
    }
  });
  test("a long marker-free message is a report, never a relay", () => {
    expect(relayLike(`Analyse. ${"Elle compare les règles une par une. ".repeat(30)}`)).toBe(false);
  });
});

describe("outcome guard: report shape (lists, several sentences) is never a relay", () => {
  test("a decision report of four sentences passes (real message 2026-11-15)", () => {
    const t = "Pour le hook de fin de tour, j'ai choisi l'option qui ne perd aucune protection. Le lead n'est plus bloqué quand ses sous-agents ont testé leur code. Il reste bloqué si un sous-agent a laissé du code non testé, et ce n'est pas une fausse alerte : c'est un vrai problème. L'agent ajoute ce cas.";
    expect(classifyFinalMessage(t).markers).toContain("multi-sentence");
    expect(classifyFinalMessage(t).relayLike).toBe(false);
  });
  test("a bullet list passes (en)", () => {
    const t = "The second pass confirmed two points and refuted three:\n- **E:** digits are not recognised.\n- **D:** the guard can judge the previous turn.\n- **A:** two reports were blocked.";
    expect(classifyFinalMessage(t).markers).toContain("list");
    expect(classifyFinalMessage(t).relayLike).toBe(false);
  });
  test("four sentences in Chinese and Hindi pass", () => {
    expect(classifyFinalMessage("第一步完成。第二步进行中。第三步等待。第四步未开始。").markers).toContain("multi-sentence");
    expect(classifyFinalMessage("पहला काम पूरा हुआ। दूसरा चल रहा है। तीसरा बाकी है। चौथा शुरू नहीं हुआ।").markers).toContain("multi-sentence");
  });
  test("250+ characters of prose pass, in any script (en, Thai without terminators)", () => {
    const en = "The commit cycle rule now reads the same in the template, the tooling rules, the lead orchestration skill and the commit agent, and the challenger confirmed that no safeguard is weakened by the change, neither on the Stop side nor on the dispatch side.";
    const th = "ตอนนี้กฎวงจรการคอมมิตอ่านเหมือนกันทั้งในเทมเพลต กฎเครื่องมือ สกิลการประสานงานของหัวหน้า และเอเจนต์คอมมิต และผู้ท้าทายยืนยันแล้วว่าไม่มีมาตรการป้องกันใดอ่อนลงจากการเปลี่ยนแปลงนี้ ".repeat(2);
    for (const t of [en, th]) {
      expect(t.length).toBeGreaterThanOrEqual(230);
      expect(classifyFinalMessage(t).markers).toContain("long-body");
      expect(classifyFinalMessage(t).relayLike).toBe(false);
    }
  });
  test("long text inside code spans or fenced blocks does not count as prose", () => {
    const code = "`" + "x".repeat(300) + "` still running here";
    const fenced = "En cours, voici la sortie :\n```\n" + "log line\n".repeat(60) + "```";
    expect(classifyFinalMessage(code).markers).not.toContain("long-body");
    expect(classifyFinalMessage(fenced).markers).not.toContain("long-body");
  });
  test("one or two sentences without a list stay relays", () => {
    expect(relayLike("Kimi finit encore ses derniers points. L'analyse tourne toujours.")).toBe(true);
    expect(relayLike("Toujours en attente : Kimi fait son commit WIP avant d'envoyer son rapport final. Rien n'attend ton action.")).toBe(true);
  });
});

describe("outcome guard: any structural marker or owner action lets the message through", () => {
  const passing: Array<[string, string]> = [
    ["url", "La PR est ouverte : https://github.com/Fusengine/claude-plugins/pull/86 pour relecture."],
    ["commit-hash", "Commit WIP 771158c sur la branche, rien n'est poussé pour l'instant."],
    ["pr-number", "PR #86 fusionnée, la branche main est à jour sur tous les dépôts."],
    ["file-path", "Le rapport est dans docs/reports/2026-11-15-workflow-challenge.md maintenant."],
    ["ratio", "validate 26/26 sur la branche, rien d'autre à signaler pour le moment."],
    ["percent-or-unit", "Le chargement a pris 340 ms contre 410 ms avant la correction, soit moins."],
    ["exit-code", "La commande de build s'est terminée avec exit 0 sur la branche."],
    ["version-tag", "Le tag v1.40.0 est posé sur main et la release est dessus."],
    ["table", "Résultat :\n\n| Dépôt | État |\n|---|---|\n| Codex | ok |"],
    ["check-symbol", "Les quatre contrôles sont passés ✅ sur la branche de travail courante."],
    ["figures", "Les tests passent : 367 sur 367, sur 31 fichiers dans la branche de travail."],
    ["figures", "31 个文件已修改，其中 12 个失败，其余全部通过检查，稍后继续处理。"],
    ["quoted-phrase", "Kimi attend ton « go release » tapé dans sa fenêtre pour continuer ensuite."],
    ["quoted-phrase", "Kimi は「go release」と入力されるのを待っています、続きはそのあとです。"],
    ["question", "Je lance la release sur les quatre dépôts ou seulement sur celui-ci ?"],
    ["fenced-command", "Pour débloquer, tape dans sa fenêtre la commande suivante :\n```\nOui, lance\n```"],
  ];
  for (const [kind, text] of passing) {
    test(`${kind}: ${text.slice(0, 40)}`, () => {
      const v = classifyFinalMessage(text);
      expect(v.markers).toContain(kind);
      expect(v.relayLike).toBe(false);
    });
  }
  test("a question mark inside a URL query alone is not an owner question", () => {
    expect(classifyFinalMessage("voir a?b=1 plus tard, rien d'autre ici").markers).not.toContain("question");
  });
  test("the lexical content never matters: result words, in-flight words, negations decide nothing", () => {
    const a = classifyFinalMessage("Le portage est publié et tout est mergé, tout est corrigé et vérifié.");
    const b = classifyFinalMessage("Le portage n'est pas encore publié, rien n'est mergé, tout tourne toujours.");
    expect(a.relayLike).toBe(b.relayLike);
    expect(a.markers).toEqual(b.markers);
  });
});
