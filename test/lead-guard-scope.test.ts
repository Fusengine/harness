import { test, expect, describe } from "bun:test";
import { briefText, checkBrief, isBriefCall, normalizeWs, ownerRulesQuotes } from "../src/policy/lead-guards/owner-rules";

const OWNER = [normalizeWs("ca doit etre garsantie"), normalizeWs("je ne veux aucune regression\n je veux de l'efficacité et de la garantie")];

const brief = (rules: string): string => `OWNER RULES (verbatim): ${rules}\n\nWRITE: src/a.ts\nOUTPUT: done\nPROOF: bun test\nNON-GOALS: none\nTEAM: main`;

describe("ownerRulesQuotes", () => {
  test("extracts « », curly and straight quotes from the OWNER RULES section only", () => {
    const q = ownerRulesQuotes(`OWNER RULES: « un », “deux deux” et "trois trois"\nWRITE: « hors section »`);
    expect(q).toEqual(["deux deux", "trois trois"]);
  });
  test("quotes shorter than 3 chars are ignored", () => {
    expect(ownerRulesQuotes("OWNER RULES: « oui » « a » « ok »\nWRITE: x")).toEqual(["oui"]);
  });
  test("template listing 'OWNER RULES / WRITE / OUTPUT' has no section", () => {
    expect(ownerRulesQuotes("fixed headers: OWNER RULES / WRITE / OUTPUT / PROOF, « une citation »")).toEqual([]);
  });
  test("no OWNER RULES header -> no quotes", () => {
    expect(ownerRulesQuotes("WRITE: « x y z »")).toEqual([]);
  });
});

describe("checkBrief", () => {
  test("verbatim quote of a real owner message passes (whitespace-normalized)", () => {
    expect(checkBrief(brief("« ca doit etre   garsantie »"), OWNER).ok).toBe(true);
    expect(checkBrief(brief("« je ne veux aucune regression je veux de l'efficacité »"), OWNER).ok).toBe(true);
  });
  test("an invented quote is denied with a one-line reason", () => {
    const v = checkBrief(brief("« le patron a dit de tout supprimer »"), OWNER);
    expect(v.ok).toBe(false);
    expect(v.reason.split("\n")).toHaveLength(1);
    expect(v.reason).toContain("OWNER RULES");
  });
  test("missing OWNER RULES section is denied", () => {
    const v = checkBrief("WRITE: src/a.ts\nPROOF: bun test", OWNER);
    expect(v.ok).toBe(false);
  });
  test("one genuine quote among invented ones passes", () => {
    expect(checkBrief(brief("« inventé inventé » « ca doit etre garsantie »"), OWNER).ok).toBe(true);
  });
  test("case differences are not forgiveness", () => {
    expect(checkBrief(brief("« CA DOIT ETRE GARSANTIE »"), OWNER).ok).toBe(false);
  });
});

describe("isBriefCall / briefText", () => {
  test("Agent and Task are always briefs", () => {
    expect(isBriefCall("Agent", "go")).toBe(true);
    expect(isBriefCall("Task", "go")).toBe(true);
  });
  test("SendMessage is a brief only with >= 2 fixed headers", () => {
    expect(isBriefCall("SendMessage", "ok, continue")).toBe(false);
    expect(isBriefCall("SendMessage", "Status request from main: report now")).toBe(false);
    expect(isBriefCall("SendMessage", "OWNER RULES: « x y z »\nWRITE: a")).toBe(true);
    expect(isBriefCall("SendMessage", "WRITE: a\nPROOF: b")).toBe(true);
  });
  test("other tools are never briefs", () => {
    expect(isBriefCall("Bash", "OWNER RULES WRITE PROOF")).toBe(false);
  });
  test("briefText reads prompt (Agent) or message (SendMessage)", () => {
    expect(briefText("Agent", { prompt: "p" })).toBe("p");
    expect(briefText("SendMessage", { message: "m" })).toBe("m");
    expect(briefText("SendMessage", { message: { type: "x" } })).toBe("");
    expect(briefText("Agent", {})).toBe("");
  });
});
