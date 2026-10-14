/** @module motion/guard-key Signing keys are inaccessible to agent tools. */
import { homedir } from "node:os";
import type { Prompt } from "../../prompt/types";
import type { NormalizedEvent } from "../../runtime/normalize";
import { canonicalFilePath } from "../../runtime/prd/prd-canon";
import { MOTION_KEY_FRAGMENT, motionKeyDirectory } from "./store";
import { isUnder } from "./paths";
import { MOTION_WRITE_TOOLS } from "./constants";
import { commandTokens, expansionText } from "./shell-verbs";
import { commandContexts, homePath } from "./command-context";

/** Deny direct, canonical alias, glob and variable references to private signing keys. */
export function motionKeyViolation(event: NormalizedEvent, cwd: string, home: string = homedir()): Prompt | null {
  const directory = canonicalFilePath(motionKeyDirectory(home));
  const names = [event.filePath, ...(event.files ?? []).map((f) => f.filePath)];
  for (const field of ["path", "file_path", "directory", "pattern", "glob", "command", "patch"]) {
    const value = event.input[field];
    if (typeof value === "string") names.push(value);
  }
  if (event.command) {
    names.push(event.command, expansionText(event.command));
    for (const [segment, shellCwd] of commandContexts(event.command, cwd, home)) {
      const tokens = commandTokens(segment);
      for (const token of tokens) names.push(token, homePath(token, shellCwd, home));
      const verb = tokens[0]?.split("/").at(-1);
      if (verb && /^(?:tar|bsdtar|gtar|unzip|ditto)$/.test(verb)) {
        const dirFlag = tokens.findIndex((t) => t === "-C" || t === "--directory" || t === "--cd" || t === "-d");
        const joinedDir = tokens.find((t) => /^(?:--(?:directory|cd)=|-C.|-d.)/.test(t));
        const output = dirFlag >= 0 ? tokens[dirFlag + 1] : joinedDir ? joinedDir.replace(/^(?:--(?:directory|cd)=|-C|-d)/, "") : verb === "ditto" ? tokens.at(-1) : shellCwd;
        if (output && isUnder(directory, canonicalFilePath(homePath(output, shellCwd, home)))) {
          return { kind: "block", title: "Motion signing key guard", reason: "Archive extraction cannot replace private motion signing keys." };
        }
      }
      if (verb && /^(?:rg|grep|find|cp|mv|rm|rsync|ln|install|ditto|tar|bsdtar|gtar|zip|chmod|chown)$/.test(verb)) {
        for (const token of tokens.slice(verb === "grep" || verb === "rg" ? 2 : 1)) {
          if (!token.startsWith("-") && isUnder(directory, canonicalFilePath(homePath(token, shellCwd, home)))) {
            return { kind: "block", title: "Motion signing key guard", reason: "Recursive searches cannot traverse the private motion signing-key directory." };
          }
        }
      }
    }
  }
  const violation = names.some((name) => {
    if (!name) return false;
    if (name.includes(MOTION_KEY_FRAGMENT) || /\.fuse-harness\/motion[*?\[]/.test(name)) return true;
    if (/\.fuse-harness\/(?:[*?\[]|$)/.test(name)) return true;
    if (/[$*?[]/.test(name) && /\.fuse-har/.test(name)) return true;
    const path = canonicalFilePath(homePath(name, cwd, home));
    return isUnder(path, directory) || ((/grep|glob|search/i.test(event.tool) || MOTION_WRITE_TOOLS.has(event.tool)) && isUnder(directory, path));
  });
  return violation ? { kind: "block", title: "Motion signing key guard", reason: "Private motion signing keys cannot be read, searched, modified, replaced or deleted by an agent." } : null;
}
