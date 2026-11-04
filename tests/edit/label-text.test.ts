import { describe, expect, test } from "bun:test";
import { extractLabels } from "../../src/mehrpele/extract";
import { escapeMehrpele, formatLabel, labelText, needsMarkdown, unescapeMehrpele, withMehrpeleDirective } from "../../src/edit/label-text";

const MD = { markdownBlock: true, canSwitch: true, wasQuoted: false };
const PLAIN = { markdownBlock: false, canSwitch: false, wasQuoted: false };

describe("Mehrpele escaping", () => {
  const cases = [
    'say "hi"',
    "$\\nabla_\\theta \\mathbb{E}[R(\\tau)]x$",
    "trailing \\",
    'back\\"quote',
    "two \\\\ slashes",
    "> [!note] Title\n> body with `code`",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "~~~mermaid\nflowchart TD\n  X[\"q\"] --> Y\n~~~",
  ];
  test.each(cases)("round-trips %p", (md) => {
    const raw = escapeMehrpele(md);
    expect(unescapeMehrpele(raw)).toBe(md);
    // The label scanner sees exactly one label with this text.
    const labels = extractLabels(`flowchart LR\n  A["${raw}"] --> B`);
    expect(labels[0]!.markdown).toBe(md);
  });
  test("LaTeX is written as typed", () => {
    expect(escapeMehrpele("$\\nabla x$")).toBe("$\\nabla x$");
  });
});

describe("formatLabel", () => {
  test("plain text stays plain and unquoted", () => {
    expect(formatLabel("Render with Pele", PLAIN)).toEqual({ raw: "Render with Pele", switchToMehrpele: false, quoted: false });
    expect(formatLabel("Hello, world!", MD)).toEqual({ raw: "Hello, world!", switchToMehrpele: false, quoted: false });
  });
  test("Markdown in a Mehrpele block is quoted and escaped", () => {
    expect(formatLabel('**Bold** "q" [[Note]]', MD).raw).toBe('"**Bold** \\"q\\" [[Note]]"');
  });
  test("a quoted label stays quoted", () => {
    expect(formatLabel("plain", { ...MD, wasQuoted: true }).raw).toBe('"plain"');
  });
  test("Markdown switches a plain block when allowed", () => {
    const f = formatLabel("see [[Note]]", { markdownBlock: false, canSwitch: true, wasQuoted: false });
    expect(f).toEqual({ raw: '"see [[Note]]"', switchToMehrpele: true, quoted: true });
  });
  test("without Mehrpele, Markdown becomes a quoted plain label", () => {
    expect(formatLabel('a "b"\nc (d)', PLAIN).raw).toBe('"a #quot;b#quot;<br>c (d)"');
    expect(formatLabel("**x**", { ...PLAIN, wasMarkdownString: true }).raw).toBe('"`**x**`"');
  });
  test("needsMarkdown", () => {
    expect(needsMarkdown("plain words")).toBe(false);
    expect(needsMarkdown("$x^2$")).toBe(true);
    expect(needsMarkdown("- item")).toBe(true);
    expect(needsMarkdown("line\nbreak")).toBe(true);
  });
});

describe("labelText", () => {
  test("reads quoted, Markdown-string and plain forms", () => {
    expect(labelText('"a \\"b\\""', true).text).toBe('a "b"');
    expect(labelText('"`**x**`"', false)).toEqual({ text: "**x**", markdownString: true });
    expect(labelText("a<br>b #quot;c#quot;", false).text).toBe('a\nb "c"');
  });
  test("directive insertion keeps indentation, once", () => {
    expect(withMehrpeleDirective("flowchart TD\n  A")).toBe("%% mehrpele %%\nflowchart TD\n  A");
    expect(withMehrpeleDirective("%% mehrpele %%\nflowchart TD")).toBe("%% mehrpele %%\nflowchart TD");
  });
});
