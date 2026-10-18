// toSpeakable(): turns an LLM reply (often markdown, despite the system prompt) into plain text a TTS model can
// read aloud. Structure becomes punctuation (a heading or list item ends with a full stop, a table row is read
// as its cells separated by commas), decoration disappears (bold, italics, emoji, rules), code blocks become
// "kod bloğu" and URLs "bağlantı". Numbers, dates and units are left alone: Antalia's own normaliser reads them.

const CODE_BLOCK = "kod bloğu";
const LINK = "bağlantı";

const END_PUNCT = /[.!?…:;,]$/;

/** private-use area offset for escaped markdown characters (ASCII only) */
const ESCAPE_BASE = 0xe000;

/** emoji and the invisible characters that glue them together (ZWJ, variation selectors, skin tones, keycaps) */
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}‍︎️⃣]/gu;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"'\]\[]*[^\s<>()"'\]\[.,;:!?…]/giu;

function endSentence(line: string): string {
  const t = line.trim();
  return !t || END_PUNCT.test(t) ? t : `${t}.`;
}

function tableRow(line: string): string | null {
  const t = line.trim();
  const pipes = (t.match(/\|/g) ?? []).length;
  if (!(t.startsWith("|") || pipes >= 2)) return null;
  // separator row: | --- | :---: |
  if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t)) return "";
  const cells = t
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);
  return cells.length ? endSentence(cells.join(", ")) : "";
}

function line(raw: string): string {
  let l = raw.replace(/^\s{0,3}>+\s?/, ""); // blockquote
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return ""; // horizontal rule
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
  if (heading) return endSentence(heading[1]);
  const row = tableRow(l);
  if (row !== null) return row;
  const bullet = /^\s*(?:[-*+•▪●◦‣]|\d{1,3}[.)])\s+(.*)$/.exec(l);
  if (bullet) return endSentence(bullet[1]);
  l = l.trim();
  return l;
}

function emphasis(t: string): string {
  return (
    t
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu, "$1$2")
      .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2")
      // unpaired markers left over when a sentence boundary fell inside an emphasised span
      .replace(/\*\*|__|~~/g, "")
      .replace(/(^|\s)\*+(?=\S)/g, "$1")
      .replace(/(?<=\S)\*+(?=\s|$|[.,!?;:…])/g, "")
  );
}

export function toSpeakable(markdown: string): string {
  let t = markdown.replace(/\r\n?/g, "\n");

  // code: fenced blocks (also one still open at the end of a streamed reply), then inline code
  t = t.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, `\n${CODE_BLOCK}.\n`);
  t = t.replace(/`([^`\n]+)`/g, "$1").replace(/`+/g, "");

  // links and images keep their text; link definitions disappear; bare URLs are announced
  t = t.replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, "");
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+["'][^"']*["'])?\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  t = t.replace(/<(?:https?:\/\/|mailto:)[^>]+>/gi, LINK);
  t = t.replace(URL_RE, LINK);

  // HTML tags and markdown escapes
  t = t.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[a-z][^>]*>/gi, " ");
  // markdown escapes: park the escaped characters out of reach of the emphasis rules, restore them at the end
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, c: string) => String.fromCharCode(ESCAPE_BASE + c.charCodeAt(0)));

  t = t
    .split("\n")
    .map(line)
    .filter((l) => l.length > 0)
    .join(" ");

  t = emphasis(t);
  t = t.replace(EMOJI, "");
  t = t.replace(/[\uE000-\uE07F]/g, (c) => String.fromCharCode(c.charCodeAt(0) - ESCAPE_BASE));

  // tidy: whitespace, space before punctuation, a full stop doubled by the structure rules
  t = t
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?…:;])/g, "$1")
    .replace(/([!?…:;,])\.(?!\.)/g, "$1")
    .replace(/(^|[^.])\.\s*\.(?!\.)/g, "$1.")
    .replace(/^[\s.,;:!?…-]+/, "")
    .trim();

  return /[\p{L}\p{N}]/u.test(t) ? t : "";
}
