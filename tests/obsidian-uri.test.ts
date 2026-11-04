import { describe, expect, test } from "bun:test";
import {
  classifyLink,
  classifyObsidianUri,
  obsidianUriBlockedMessage,
} from "../src/link-classify";

const allowedPolicy = {
  allowCommandUris: true,
  commandAllowlist: ["mehrpele:copy-diagram-svg", "app:open-help"],
};

describe("obsidian URI navigation", () => {
  test("allows core open navigation", () => {
    expect(classifyObsidianUri("obsidian://open?vault=Vault&file=Folder%2FNote.md")).toEqual({
      outcome: "navigation",
      action: "open",
      parameters: ["vault", "file"],
    });
    expect(classifyObsidianUri("obsidian://open?path=%2Fvault%2FNote.md").outcome).toBe("navigation");
    expect(classifyLink("obsidian://open?vault=V&file=Note")).toBe("obsidian");
  });

  test("allows Advanced URI read/navigation parameters", () => {
    const uri =
      "obsidian://adv-uri?vault=V&filepath=Folder%2FNote.md&heading=Intro&block=pele-abcd1234&line=12&openmode=split&viewmode=preview";
    expect(classifyObsidianUri(uri).outcome).toBe("navigation");
    expect(classifyObsidianUri("obsidian://adv-uri?filename=Note&uid=123").outcome).toBe("navigation");
    expect(classifyObsidianUri("obsidian://adv-uri?file=Note.md").outcome).toBe("navigation");
  });

  test("action and parameter-name case variations are canonicalised", () => {
    expect(classifyObsidianUri("OBSIDIAN://ADV-URI?VAULT=V&FilePath=Note.md&Heading=H").outcome).toBe("navigation");
    expect(classifyObsidianUri("obsidian://AdV-uRi?vault=V&filepath=Note.md").outcome).toBe("navigation");
  });
});

describe("obsidian URI blocked matrix", () => {
  const blocked = [
    ["command by default", "obsidian://adv-uri?commandid=app%3Adelete-file"],
    ["command name", "obsidian://adv-uri?commandname=Delete%20file"],
    ["write data", "obsidian://adv-uri?filepath=Note.md&data=pwned&mode=overwrite"],
    ["mode alone", "obsidian://adv-uri?filepath=Note.md&mode=append"],
    ["clipboard", "obsidian://adv-uri?filepath=Note.md&clipboard=true"],
    ["setting", "obsidian://adv-uri?settingid=community-plugins"],
    ["eval legacy", "obsidian://adv-uri?eval=alert(1)"],
    ["enable plugin", "obsidian://adv-uri?enable-plugin=evil"],
    ["disable plugin", "obsidian://adv-uri?disable-plugin=core"],
    ["workspace load", "obsidian://adv-uri?workspace=Other"],
    ["workspace save", "obsidian://adv-uri?saveworkspace=true"],
    ["search replace", "obsidian://adv-uri?filepath=Note.md&search=a&replace=b"],
    ["search regex replace", "obsidian://adv-uri?filepath=Note.md&searchregex=a&replace=b"],
    ["frontmatter write", "obsidian://adv-uri?filepath=Note.md&frontmatterkey=x&data=y"],
    ["unknown action", "obsidian://delete?vault=V&file=Note.md"],
    ["unknown parameter", "obsidian://adv-uri?filepath=Note.md&surprise=1"],
    ["core new content write", "obsidian://new?name=Note&content=pwned"],
    ["callback", "obsidian://adv-uri?filepath=Note.md&x-success=obsidian%3A%2F%2Fopen"],
    ["update plugins", "obsidian://adv-uri?updateplugins=true"],
    ["daily creation", "obsidian://adv-uri?daily=true"],
  ] as const;

  for (const [name, uri] of blocked) {
    test(`blocks ${name}`, () => {
      expect(classifyObsidianUri(uri).outcome).toBe("blocked");
      expect(classifyLink(uri)).toBe("obsidian-blocked");
      // Even the permissive command policy never allows writes/privileged params.
      expect(classifyObsidianUri(uri, allowedPolicy).outcome).toBe(
        name === "command by default" ? "blocked" : "blocked",
      );
    });
  }

  test("encoded parameter names and values cannot hide commands", () => {
    expect(classifyObsidianUri("obsidian://adv-uri?%63ommandid=app%3Adelete-file").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://adv-uri?command%69d=app%3Adelete-file").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://adv-uri?COMMANDID=app%3Adelete-file").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://adv-uri?command-id=app%3Adelete-file").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://adv-uri?%2563ommandid=app%253Adelete-file").outcome).toBe("blocked");
  });

  test("double-encoded legacy advanced-uri is inspected", () => {
    const safe = encodeURIComponent("vault=V&filepath=Note.md&heading=Intro");
    expect(classifyObsidianUri(`obsidian://advanced-uri?${safe}`).outcome).toBe("navigation");
    const dangerous = encodeURIComponent("vault=V&filepath=Note.md&data=pwned&mode=overwrite");
    expect(classifyObsidianUri(`obsidian://advanced-uri?${dangerous}`).outcome).toBe("blocked");
    const doubleDangerous = encodeURIComponent(dangerous);
    expect(classifyObsidianUri(`obsidian://advanced-uri?${doubleDangerous}`).outcome).toBe("blocked");
  });

  test("malformed and extra-path URIs fail closed", () => {
    expect(classifyObsidianUri("obsidian://adv-uri/extra?filepath=Note.md").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://adv-uri?commandid=").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://adv-uri?commandid=a:x&commandid=b:y", allowedPolicy).outcome).toBe("blocked");
  });
});

describe("obsidian command policy", () => {
  const uri = "obsidian://adv-uri?commandid=mehrpele%3Acopy-diagram-svg";

  test("command is blocked when the switch is off", () => {
    const result = classifyObsidianUri(uri, { commandAllowlist: ["mehrpele:copy-diagram-svg"] });
    expect(result.outcome).toBe("blocked");
    expect(obsidianUriBlockedMessage(result)).toContain("Allow command URIs from diagrams");
  });

  test("exact allowlisted command id may run when the switch is on", () => {
    expect(classifyObsidianUri(uri, allowedPolicy)).toEqual({
      outcome: "command",
      action: "adv-uri",
      commandId: "mehrpele:copy-diagram-svg",
      parameters: ["commandid"],
    });
    expect(classifyLink(uri, false, allowedPolicy)).toBe("obsidian");
  });

  test("non-allowlisted and similarly named commands stay blocked", () => {
    expect(classifyObsidianUri("obsidian://adv-uri?commandid=app%3Adelete-file", allowedPolicy).outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://adv-uri?commandid=mehrpele%3Acopy-diagram-svg2", allowedPolicy).outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://adv-uri?commandid=MEHRPELE%3ACOPY-DIAGRAM-SVG", allowedPolicy).outcome).toBe("blocked");
  });

  test("allowlisted command plus a write parameter is still blocked", () => {
    expect(
      classifyObsidianUri(`${uri}&filepath=Note.md&data=pwned`, allowedPolicy).outcome,
    ).toBe("blocked");
  });
});

import { isObsidianUri as isObs, urlStandardClean } from "../src/link-classify";

describe("URL-standard pre-processing", () => {
  test("strips C0 controls and spaces at both ends, tab/CR/LF anywhere", () => {
    expect(urlStandardClean("\u0000\u0001 obsidian://open\t?x=1\u001f ")).toBe("obsidian://open?x=1");
    // Only C0 + space are trimmed: DEL, C1 controls and other whitespace stay (URL Standard).
    expect(urlStandardClean("\u007fobsidian://open\u0085 ")).toBe("\u007fobsidian://open\u0085 ");
  });
  test("isObsidianUri sees through C0 prefixes", () => {
    expect(isObs("\u0001obsidian://adv-uri?commandid=x")).toBe(true);
    expect(isObs("\u001fOBSIDIAN://open")).toBe(true);
    expect(isObs("x obsidian://open")).toBe(false);
  });
  test("classifyLink blocks C0-prefixed command URIs instead of treating them as notes", () => {
    expect(classifyLink("\u0001obsidian://adv-uri?commandid=app%3Areload")).toBe("obsidian-blocked");
    expect(classifyLink("\u0001javascript:alert(1)")).toBe("blocked");
  });
  test("decoded action is compared exactly", () => {
    expect(classifyObsidianUri("obsidian://o.pen?vault=V").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://advuri?vault=V&filepath=a.md").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://%61dv-uri?vault=V&filepath=a.md").outcome).toBe("navigation");
    expect(classifyObsidianUri("obsidian://__proto__?vault=V").outcome).toBe("blocked");
  });
});
