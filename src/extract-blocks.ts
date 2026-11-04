/** DOM-free extraction of fenced code blocks from markdown text. */

export interface CodeBlock {
  lang: string;
  code: string;
  /** 0-based line of the opening fence. */
  startLine: number;
  /** 0-based line of the closing fence (or last line if unterminated). */
  endLine: number;
}

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`~]*).*$/;

export function extractBlocks(
  markdown: string,
  langs: readonly string[] = ["mermaid", "pele"],
): CodeBlock[] {
  const wanted = new Set(langs.map((l) => l.toLowerCase()));
  // CRLF: match fences without the trailing \r (sources are LF-normalised),
  // so block indices agree with pele-render's extraction on any line ending.
  const lines = markdown.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const blocks: CodeBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_RE.exec(lines[i] ?? "");
    if (!m) {
      i++;
      continue;
    }
    const fence = m[2] ?? "```";
    const lang = (m[3] ?? "").toLowerCase();
    const startLine = i;
    const body: string[] = [];
    i++;
    let closed = false;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      const close = FENCE_RE.exec(line);
      // A closing fence: same marker char, at least as long, no info string.
      if (
        close &&
        (close[2] ?? "").startsWith(fence[0] ?? "`") &&
        (close[2] ?? "").length >= fence.length &&
        !(close[3] ?? "")
      ) {
        closed = true;
        break;
      }
      body.push(line);
      i++;
    }
    const endLine = closed ? i : lines.length - 1;
    if (wanted.has(lang)) {
      blocks.push({ lang, code: body.join("\n"), startLine, endLine });
    }
    i = closed ? i + 1 : lines.length;
  }
  return blocks;
}

/** Block whose fence range (inclusive) contains `line` (0-based), if any. */
export function blockAtLine(blocks: readonly CodeBlock[], line: number): CodeBlock | undefined {
  return blocks.find((b) => line >= b.startLine && line <= b.endLine);
}
