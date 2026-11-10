import type { CorpusRow } from "./redir-corpus";

/**
 * Redirect-narrowing corpus part C: when is the `S=` binding provably executed before every `$S` use.
 * `/usr` is an existing, enterable directory on every CI host; `/etc/hosts` an existing file; `/nonexistent-dir-x` absent.
 * Only an unconditional binding (command start, after `;` / newline that does not follow an operator) or the owner's
 * `cd <existing abs dir> && S=...` form is safe; every other guarded or continued binding must keep asking.
 */
export const ROWS_C: readonly CorpusRow[] = [
  { id: "W1", cmd: "true ||\nS=@D; echo x > $S/a", old: "ask" },
  { id: "W2", cmd: "true |\nS=@D; echo x > $S/a", old: "ask" },
  { id: "W3", cmd: "true ||\r\nS=@D; echo x > $S/a", old: "ask" },
  { id: "W4", cmd: "true || # c\nS=@D; echo x > $S/a", old: "ask" },
  { id: "W5", cmd: "true &&\nS=@D; echo x > $S/a", old: "ask" },
  { id: "W6", cmd: "true |&\nS=@D; echo x > $S/a", old: "ask" },
  { id: "W7", cmd: "true ||\n\n  \nS=@D; echo x > $S/a", old: "ask" },
  { id: "W8", cmd: "true \\\nS=@D; echo x > $S/a", old: "ask" },
  { id: "W9", cmd: "true && S=@D; echo x > $S/a", old: "ask" },
  { id: "W10", cmd: "false || S=@D; echo x > $S/a", old: "ask" },
  { id: "W11", cmd: "cd /nonexistent-dir-x && S=@D; echo x > $S/a", old: "ask" },
  { id: "W12", cmd: "cd /etc/hosts && S=@D; echo x > $S/a", old: "ask" },
  { id: "W13", cmd: "cd -P /usr && S=@D; echo x > $S/a", old: "ask" },
  { id: "W14", cmd: "cd \"$X\" && S=@D; echo x > $S/a", old: "ask" },
  { id: "W15", cmd: "cd /usr || S=@D; echo x > $S/a", old: "ask" },
  { id: "W16", cmd: "cd ~ && S=@D; echo x > $S/a", old: "ask" },
  { id: "W17", cmd: "cd /us* && S=@D; echo x > $S/a", old: "ask" },
  { id: "W18", cmd: "cd $HOME && S=@D; echo x > $S/a", old: "ask" },
  { id: "W19", cmd: "cd '/usr' && S=@D; echo x > $S/a", old: "ask" },
  { id: "W20", cmd: "cd /usr >/dev/null && S=@D; echo x > $S/a", old: "ask" },
  { id: "W21", cmd: "cd usr && S=@D; echo x > $S/a", old: "ask" },
  { id: "W22", cmd: "cd /usr && cd /usr && S=@D; echo x > $S/a", old: "ask" },
  { id: "W23", cmd: "true && cd /usr && S=@D; echo x > $S/a", old: "ask" },
  { id: "W24", cmd: "true || cd /usr && S=@D; echo x > $S/a", old: "ask" },
  { id: "W25", cmd: "cd /usr &&\nS=@D; echo x > $S/a", old: "ask" },
  { id: "W26", cmd: "cd /usr\n&& S=@D; echo x > $S/a", old: "ask" },
  { id: "W27", cmd: "cd /usr ; S=@D && echo x > $S/a; true || S=@P; echo y > $S/b", old: "ask" },
  { id: "W28", cmd: "echo a ||\ncd /usr && S=@D; echo x > $S/a", old: "ask" },
  { id: "W29", cmd: "cd /usr && S=@D; echo x > $S/a", old: "ask", safe: true },
  { id: "W30", cmd: "cd /usr&&S=@D;echo x > $S/a", old: "ask", safe: true },
  { id: "W31", cmd: "cd\t/usr  &&  S=@D\necho x > $S/a", old: "ask", safe: true },
  { id: "W32", cmd: "echo a; cd /usr && S=@D; echo x > $S/a", old: "ask", safe: true },
  { id: "W33", cmd: "echo a\ncd /usr && S=@D; echo x > $S/a", old: "ask", safe: true },
  { id: "W34", cmd: "echo a;\n\nS=@D; echo x > $S/a", old: "ask", safe: true },
  { id: "W35", cmd: "echo a\n\nS=@D; echo x > $S/a", old: "ask", safe: true },
  { id: "W36", cmd: "cd /usr && S=@D; HOME=$S/h timeout 560 bun test > $S/t.log 2>&1; tail -6 $S/t.log", old: "ask", safe: true },
  { id: "W37", cmd: "true ||\n echo a; S=@D; echo x > $S/a", old: "ask", safe: true },
];
