// SentenceStream: cuts a streamed LLM reply into sentences as soon as each one is complete, so speech can
// start long before the reply is finished.
//
// A sentence ends at . ! ? … (plus closing quotes / brackets) followed by whitespace, at ": " and at a line
// break. A full stop is not an end when it belongs to an abbreviation (Dr. Prof. vb. örn. A.Ş. …), an initial
// ("M. Kemal"), a decimal (3.5, 1.250: no space follows) or an ordinal ("15. yüzyıl": the next word is
// lowercase). Because of that look-ahead, a stop at the very end of the buffer waits for the next delta.
// Very short sentences are merged with the next one (better prosody, fewer TTS calls); a run longer than
// `maxChars` without an end is cut at a comma, else at a space. Fenced code blocks are kept whole.

export interface Sentence {
  /** the sentence as written (trimmed) */
  text: string;
  /** offsets into the whole reply text: text === reply.slice(start, end) */
  start: number;
  end: number;
  index: number;
}

export interface SentenceStreamOptions {
  /** sentences shorter than this are merged with the next one (default 12 characters) */
  minChars?: number;
  /** longer runs without an end are cut (default 220 characters) */
  maxChars?: number;
}

/** never end a sentence (titles, "örn.", "No. 5") */
const ABBREVIATIONS = new Set(
  [
    "dr", "prof", "doç", "yrd", "uzm", "av", "müh", "öğr", "gör", "arş", "sn", "hz", "alb", "yzb",
    "örn", "ör", "bkz", "krş", "yy", "no", "nr", "st", "mah", "cad", "sok", "sk", "bulv", "blv", "apt",
    "s", "sf", "ltd", "şti", "inc", "corp", "mr", "mrs", "ms", "jr", "sr", "e.g", "i.e", "çev", "haz",
  ].map((s) => s.toLocaleLowerCase("tr")),
);

const CLOSERS = "\"'”’»)]}";
const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
const isLower = (c: string | undefined): boolean => c !== undefined && /\p{Ll}/u.test(c);

type Scan = { kind: "end"; at: number; /** emit even if short */ force?: boolean } | { kind: "wait"; resume: number };

export class SentenceStream {
  private all = "";
  /** start of the text not emitted yet (may hold a short sentence waiting to be merged) */
  private segStart = 0;
  /** no sentence end exists in [segStart, scanFrom) other than the held short ones */
  private scanFrom = 0;
  private count = 0;
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(opts: SentenceStreamOptions = {}) {
    this.minChars = Math.max(0, opts.minChars ?? 12);
    this.maxChars = Math.max(this.minChars + 20, opts.maxChars ?? 220);
  }

  /** the whole text received so far */
  get text(): string {
    return this.all;
  }

  push(delta: string): Sentence[] {
    if (!delta) return [];
    this.all += delta;
    return this.drain(false);
  }

  /** end of the reply: emits whatever is left */
  flush(): Sentence[] {
    const out = this.drain(true);
    const rest = this.make(this.segStart, this.all.length);
    if (rest) out.push(rest);
    this.segStart = this.scanFrom = this.all.length;
    return out;
  }

  private drain(final: boolean): Sentence[] {
    const out: Sentence[] = [];
    for (;;) {
      const r = this.scan(final);
      if (r.kind === "end") {
        this.scanFrom = r.at;
        if (!r.force && !final && this.all.slice(this.segStart, r.at).trim().length < this.minChars) continue; // hold, merge with the next
        const s = this.make(this.segStart, r.at);
        this.segStart = r.at;
        if (s) out.push(s);
        continue;
      }
      this.scanFrom = r.resume;
      // a long run with no end in sight: cut it (never inside an open code block, which `resume` points at)
      if (!final && r.resume >= this.all.length && this.all.length - this.segStart > this.maxChars) {
        const cut = this.cutPoint();
        const s = this.make(this.segStart, cut);
        this.segStart = cut;
        if (this.scanFrom < cut) this.scanFrom = cut;
        if (s) out.push(s);
        continue;
      }
      return out;
    }
  }

  private make(start: number, end: number): Sentence | null {
    const raw = this.all.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text) return null;
    return { text, start: start + lead, end: start + lead + text.length, index: this.count++ };
  }

  /** where to cut an over-long run: after the last comma / semicolon, else at the last space, else hard */
  private cutPoint(): number {
    const from = this.segStart;
    const window = this.all.slice(from, from + this.maxChars);
    const min = Math.max(this.minChars, Math.floor(this.maxChars / 3));
    for (let i = window.length - 1; i >= min; i--) {
      if (/[,;]/.test(window[i]) && isSpace(window[i + 1])) return from + i + 1;
    }
    for (let i = window.length - 1; i >= min; i--) {
      if (isSpace(window[i])) return from + i;
    }
    return from + window.length;
  }

  private scan(final: boolean): Scan {
    const s = this.all;
    const n = s.length;
    for (let i = this.scanFrom; i < n; i++) {
      const c = s[i];
      const lineStart = i === 0 || s[i - 1] === "\n";

      // fenced code block: one unit, from the opening fence to the end of the closing fence's line
      if (lineStart) {
        const open = /^ {0,3}(`{3,}|~{3,})/.exec(s.slice(i, i + 16));
        if (open) {
          // text waiting before the block goes out first, short or not: the block may take long to arrive
          if (i > this.segStart && this.all.slice(this.segStart, i).trim()) return { kind: "end", at: i, force: true };
          const openEol = s.indexOf("\n", i + open[0].length);
          if (openEol < 0) return final ? { kind: "end", at: n } : { kind: "wait", resume: i };
          const ch = open[1][0] === "`" ? "`" : "~";
          const closeRe = new RegExp(`\\n {0,3}${ch}{${open[1].length},}[ \\t]*(?:\\n|$)`, "g");
          closeRe.lastIndex = openEol;
          const close = closeRe.exec(s);
          if (!close || (!close[0].endsWith("\n") && !final)) return final ? { kind: "end", at: n } : { kind: "wait", resume: i };
          return { kind: "end", at: close.index + close[0].length };
        }
        // a partial fence ("`", "``") at the very end of the buffer: wait for more
        if (!final && /^ {0,3}(`{1,2}|~{1,2})$/.test(s.slice(i))) return { kind: "wait", resume: i };
      }

      if (c === "\n") return { kind: "end", at: i + 1 };

      if (c === ":") {
        if (i + 1 >= n) return final ? { kind: "end", at: n } : { kind: "wait", resume: i };
        if (isSpace(s[i + 1])) return { kind: "end", at: i + 1 };
        continue;
      }

      if (c === "." || c === "!" || c === "?" || c === "…") {
        let j = i;
        while (j < n && ".!?…".includes(s[j])) j++;
        while (j < n && CLOSERS.includes(s[j])) j++;
        if (j >= n) return final ? { kind: "end", at: n } : { kind: "wait", resume: i };
        if (!isSpace(s[j])) {
          i = j - 1; // "3.5", "a.b", "?!x": not an end
          continue;
        }
        const run = s.slice(i, j);
        if (run === "." || /^\.["'”’»)\]}]*$/.test(run)) {
          const verdict = this.fullStop(i, j, final);
          if (verdict === "wait") return { kind: "wait", resume: i };
          if (verdict === "no") {
            i = j - 1;
            continue;
          }
        }
        return { kind: "end", at: j };
      }
    }
    return { kind: "wait", resume: n };
  }

  /** decides a single full stop at `dot`, followed by whitespace at `after` */
  private fullStop(dot: number, after: number, final: boolean): "yes" | "no" | "wait" {
    const s = this.all;
    let w = dot;
    while (w > 0 && !isSpace(s[w - 1]) && !"([\"'“‘«".includes(s[w - 1])) w--;
    const word = s.slice(w, dot);
    const lower = word.toLocaleLowerCase("tr");

    // the first non-blank character after the stop (a line break settles it)
    let k = after;
    while (k < s.length && (s[k] === " " || s[k] === "\t")) k++;
    const next = s[k];
    if (next === "\n" || next === "\r") return "yes";
    if (next === undefined && !final) return "wait";

    if (ABBREVIATIONS.has(lower)) return "no";
    if (/^\p{Lu}$/u.test(word)) return "no"; // an initial: "M. Kemal"
    if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) return "no"; // A.Ş, e.g
    // "15. yüzyıl", "vb. şeyler", a stray stop mid-sentence; "vb. Sonra" ends the sentence
    if (next !== undefined && isLower(next)) return "no";
    return "yes";
  }
}

/** convenience for non-streamed text */
export function splitSentences(text: string, opts?: SentenceStreamOptions): Sentence[] {
  const s = new SentenceStream(opts);
  return [...s.push(text), ...s.flush()];
}
