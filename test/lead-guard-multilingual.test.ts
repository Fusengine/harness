import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFinalMessage } from "../src/policy/lead-guards/outcome-only";
import { checkBrief, normalizeWs, ownerRulesQuotes } from "../src/policy/lead-guards/owner-rules";
import { outcomeStopGate } from "../src/runtime/lead-guards/outcome-stop-gate";
import { leadScopeGate } from "../src/runtime/lead-guards/scope-pre-gate";

type Row = Record<string, unknown>;

interface Lang {
  code: string;
  /** Status narration with no structural marker. */
  relay: string;
  /** Question to the owner, with that script's question mark. */
  question: string;
  /** What the owner typed, and the same words quoted the way that language quotes. */
  owner: string;
  quoted: string;
}

const LANGS: Lang[] = [
  { code: "en", relay: "Kimi is still working on the last points, the analysis keeps running.", question: "Shall I launch the release on all four repos?", owner: "it must be guaranteed", quoted: "“it must be guaranteed”" },
  { code: "fr", relay: "Kimi finit encore ses derniers points, l'analyse tourne toujours.", question: "Je lance la release sur les quatre dépôts ?", owner: "ça doit être garanti", quoted: "« ça doit être garanti »" },
  { code: "de", relay: "Kimi arbeitet noch an den letzten Punkten, die Analyse läuft weiter.", question: "Soll ich die Release auf allen vier Repos starten?", owner: "Das muss garantiert sein", quoted: "„Das muss garantiert sein“" },
  { code: "es", relay: "Kimi sigue con los últimos puntos, el análisis continúa en marcha.", question: "¿Lanzo la release en los cuatro repositorios?", owner: "tiene que estar garantizado", quoted: "«tiene que estar garantizado»" },
  { code: "zh", relay: "Kimi 仍在处理最后几个问题，分析还在继续运行，稍后汇报结果。", question: "要在四个仓库上发布吗？", owner: "必须有保证", quoted: "「必须有保证」" },
  { code: "ja", relay: "Kimi はまだ最後の項目を処理中で、分析も実行を続けています。", question: "四つのリポジトリでリリースを開始しますか？", owner: "保証が必要です", quoted: "『保証が必要です』" },
  { code: "ar", relay: "لا يزال Kimi يعالج النقاط الأخيرة والتحليل ما زال قيد التشغيل حاليا.", question: "هل أطلق الإصدار على المستودعات الأربعة؟", owner: "يجب أن يكون مضمونا", quoted: '"يجب أن يكون مضمونا"' },
];

const human = (text: string): Row => ({ type: "user", origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: '<system-reminder>\nSession note\n</system-reminder>' }, { type: "text", text }] } });
const notif: Row = { type: "user", origin: { kind: "task-notification" }, isMeta: true, message: { role: "user", content: "<task-notification>done</task-notification>" } };
const toolUse: Row = { type: "assistant", message: { id: "m0", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: {} }] } };
const final = (text: string, id: string): Row => ({ type: "assistant", message: { id, stop_reason: "end_turn", content: [{ type: "text", text }] } });

function transcript(rows: Row[]): string {
  const p = join(mkdtempSync(join(tmpdir(), "lgm-")), "t.jsonl");
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
const stop = (path: string, msg: string): Row => ({ hook_event_name: "Stop", transcript_path: path, last_assistant_message: msg, stop_hook_active: false });

for (const l of LANGS) {
  describe(`Stop guard [${l.code}]`, () => {
    const woken = (msg: string): string => transcript([human("go"), final("old", "m0"), notif, toolUse, final(msg, "m1")]);
    const asked = (msg: string): string => transcript([notif, final("old", "m0"), human(l.owner), toolUse, final(msg, "m1")]);
    test("relay woken by a notification is blocked", () => {
      expect(classifyFinalMessage(l.relay).relayLike).toBe(true);
      expect(JSON.parse(outcomeStopGate(stop(woken(l.relay), l.relay), "claude-code", {})).decision).toBe("block");
    });
    test("same text as an answer to the owner passes", () => {
      expect(outcomeStopGate(stop(asked(l.relay), l.relay), "claude-code", {})).toBe("");
    });
    test("question to the owner passes even when woken by a notification", () => {
      expect(classifyFinalMessage(l.question).markers).toContain("question");
      expect(outcomeStopGate(stop(woken(l.question), l.question), "claude-code", {})).toBe("");
    });
    test("a report with a PR number and URL passes", () => {
      const report = `${l.relay} PR #86 https://github.com/Fusengine/claude-plugins/pull/86`;
      expect(outcomeStopGate(stop(woken(report), report), "claude-code", {})).toBe("");
    });
  });

  describe(`Scope guard [${l.code}]`, () => {
    const brief = (rules: string): Record<string, unknown> => ({ prompt: `OWNER RULES (verbatim): ${rules}\nWRITE: src/a.ts\nPROOF: bun test` });
    const tx = (): string => transcript([human(`d'accord. ${l.owner}, merci`)]);
    test("real quote in the language's own quotation marks passes", () => {
      expect(ownerRulesQuotes(brief(l.quoted).prompt as string)).toEqual([normalizeWs(l.owner)]);
      expect(leadScopeGate("Agent", brief(l.quoted), { transcript_path: tx() }, "claude-code", {})).toBeNull();
    });
    test("invented quote is denied", () => {
      const forged = l.quoted.replace(l.owner, `${l.owner} et plus encore inventé`);
      expect(leadScopeGate("Agent", brief(forged), { transcript_path: tx() }, "claude-code", {})?.kind).toBe("block");
    });
  });
}

describe("native-script digits are figures (turn woken by a notification must pass)", () => {
  const cases: Array<[string, string]> = [
    ["ar", "نجحت جميع الاختبارات: ٣٦٧ من ٣٦٧"],
    ["ar-percent", "اكتمل الفحص بنسبة ٩٨٪ حتى الآن"],
    ["zh-fullwidth", "３６７／３６７，９８％ 已完成，稍后继续处理其他项目。"],
    ["ja", "３６７件中３６７件が完了しました、残りはありません。"],
    ["hi", "३६७ में से ३६७ परीक्षण पूरे हुए, बाकी काम जारी है।"],
    ["ko", "테스트 367개 중 367개가 통과했고 나머지 작업은 계속 진행 중입니다."],
    ["ru", "Прошло 367 из 367 проверок, остальные задачи продолжаются."],
  ];
  for (const [code, text] of cases) {
    test(`${code}: ${text.slice(0, 24)}`, () => {
      expect(classifyFinalMessage(text).relayLike).toBe(false);
      const p = transcript([human("go"), final("old", "m0"), notif, toolUse, final(text, "m1")]);
      expect(outcomeStopGate(stop(p, text), "claude-code", {})).toBe("");
    });
  }
  test("a single digit, an identifier suffix and a hash-like word are not figures", () => {
    for (const t of ["Kimi traite 3 fichiers sur la branche docs/apple-skills-27 maintenant", "Le build sha367 tourne toujours sur la machine de test ici"]) {
      expect(classifyFinalMessage(t).markers).not.toContain("figures");
    }
  });
});

describe("transcript lag (Stop fires before the current turn is written)", () => {
  const RELAY = LANGS[1]!.relay;
  const lagging = (): string => transcript([human("go"), final("first", "m0"), notif, toolUse, final(RELAY, "m1")]);
  test("previous turn was a notification relay, the owner's turn is not written yet: never blocked", () => {
    const answer = "Voici la réponse à ta question, le build est en cours depuis ce matin.";
    expect(outcomeStopGate(stop(lagging(), answer), "claude-code", {})).toBe("");
  });
  test("control: when the transcript does end on the message being judged, the relay is blocked", () => {
    expect(JSON.parse(outcomeStopGate(stop(lagging(), RELAY), "claude-code", {})).decision).toBe("block");
  });
});

describe("Unicode normalization of owner quotes", () => {
  test("decomposed (NFD) owner text matches a composed (NFC) quote", () => {
    const owner = "ça doit être garanti".normalize("NFD");
    const quote = "ça doit être garanti".normalize("NFC");
    expect(owner).not.toBe(quote);
    expect(checkBrief(`OWNER RULES: « ${quote} »\nWRITE: x`, [normalizeWs(owner)]).ok).toBe(true);
  });
  test("ideographic and non-breaking spaces count as whitespace", () => {
    const owner = "必须　有保证 并且 完整";
    expect(checkBrief("OWNER RULES: 「必须 有保证 并且 完整」\nWRITE: x", [normalizeWs(owner)]).ok).toBe(true);
  });
  test("all quote styles are read: guillemets, curly, straight, German low, corner, white corner, angle", () => {
    const q = ownerRulesQuotes('OWNER RULES: «aaa aaa» “bbb bbb” "ccc ccc" „ddd ddd“ 「eee eee」 『fff fff』 ‹ggg ggg›\nWRITE: x');
    expect(q).toEqual(["aaa aaa", "bbb bbb", "ccc ccc", "ddd ddd", "eee eee", "fff fff", "ggg ggg"]);
  });
  test("Greek question (U+037E and its NFC ASCII form) at the end of a message is an owner action; mid-text is not", () => {
    const q = "Να κάνω τη συγχώνευση τώρα ή να περιμένω την ανασκόπηση;";
    for (const t of [q, q.slice(0, -1) + ";", `${q} `, `«${q}»`]) {
      expect(classifyFinalMessage(t).markers.length).toBeGreaterThan(0);
      const p = transcript([human("go"), final("old", "m0"), notif, toolUse, final(t, "m1")]);
      expect(outcomeStopGate(stop(p, t), "claude-code", {})).toBe("");
    }
    const mid = "Kimi finit l'analyse; la suite tourne toujours dans le worktree";
    expect(classifyFinalMessage(mid).markers).toEqual([]);
    expect(classifyFinalMessage(mid).relayLike).toBe(true);
  });
  test("round-4 cases pass when woken: Greek mark mid-text, Armenian, Ethiopic, '?!' and '?' + emoji", () => {
    const cases = [
      "Να κάνω τη συγχώνευση τώρα; Περιμένω την απάντησή σου.",
      "Միավորե՞մ ճյուղը հիմա, թե սպասեմ վերանայմանը",
      "ቅርንጫፉን አሁን ላዋህድ ወይስ ግምገማውን ልጠብቅ፧ ንገሩኝ",
      "Should I merge the branch now or wait for the review?!",
      "Should I merge the branch now or wait for the review?🙂",
    ];
    for (const t of cases) {
      expect(classifyFinalMessage(t).markers).toContain("question");
      const p = transcript([human("go"), final("old", "m0"), notif, toolUse, final(t, "m1")]);
      expect(outcomeStopGate(stop(p, t), "claude-code", {})).toBe("");
    }
  });
  test("a URL query mark glued to a word is still not a question", () => {
    expect(classifyFinalMessage("Voir la page a?b=1 et c?d=2 pour le détail, rien d'autre").markers).not.toContain("question");
  });
  test("question marks of every script are owner actions", () => {
    for (const q of ["¿Lanzo la release ahora mismo?", "ما هو الحل؟", "これでいいですか？", "这样可以吗？"]) {
      expect(classifyFinalMessage(q).markers).toContain("question");
    }
  });
});
