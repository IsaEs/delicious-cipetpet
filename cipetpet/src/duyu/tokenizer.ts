// SentencePiece decoding (ids -> text) for the Duyu-small vocabulary, matching
// SentencePieceProcessor.decode (sentencepiece_processor.cc, Decode):
//   * control pieces (<pad> <s> </s>) produce nothing; the unknown piece produces " ⁇ ";
//   * runs of byte pieces <0xXX> are joined and decoded as UTF-8 with sentencepiece's own decoder: an
//     invalid byte becomes one U+FFFD per byte (TextDecoder would merge a broken sequence into one);
//   * every other piece (normal, user-defined such as <tr>) is its text with "▁" -> " ", and while the
//     output is still empty one leading "▁" is dropped (the model's normaliser adds a dummy prefix and
//     removes extra whitespace, which is when sentencepiece does that).
// The vocabulary comes from the pack's tokenizer/pieces.json (FORMAT.md).

export const PIECE_NORMAL = 1;
export const PIECE_UNKNOWN = 2;
export const PIECE_CONTROL = 3;
export const PIECE_USER_DEFINED = 4;
export const PIECE_UNUSED = 5;
export const PIECE_BYTE = 6;

const SPACE = "▁";
const UNK_SURFACE = " ⁇ ";

export interface PiecesJson {
  pieces: [string, number][];
}

export class SentencePieceDecoder {
  readonly #pieces: string[];
  readonly #types: Uint8Array;
  /** byte value of each byte piece, -1 otherwise */
  readonly #byte: Int16Array;

  constructor(json: PiecesJson) {
    const list = json?.pieces;
    if (!Array.isArray(list) || list.length === 0) throw new Error("cipetpet: tokenizer/pieces.json has no pieces");
    this.#pieces = list.map((p) => p[0]);
    this.#types = Uint8Array.from(list.map((p) => p[1]));
    this.#byte = new Int16Array(list.length).fill(-1);
    list.forEach(([piece, type], i) => {
      if (type !== PIECE_BYTE) return;
      const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(piece);
      if (!m) throw new Error(`cipetpet: byte piece ${i} is "${piece}", not <0xXX>`);
      this.#byte[i] = parseInt(m[1], 16);
    });
  }

  get size(): number {
    return this.#pieces.length;
  }

  piece(id: number): string {
    this.#check(id);
    return this.#pieces[id];
  }

  type(id: number): number {
    this.#check(id);
    return this.#types[id];
  }

  /** SentencePieceProcessor.decode(ids) */
  decode(ids: readonly number[]): string {
    let text = "";
    let bytes: number[] = [];
    for (const id of ids) {
      this.#check(id);
      const type = this.#types[id];
      if (type === PIECE_BYTE) {
        bytes.push(this.#byte[id]);
        continue;
      }
      if (bytes.length) {
        text += decodeUtf8Bytes(bytes);
        bytes = [];
      }
      if (type === PIECE_CONTROL) continue;
      if (type === PIECE_UNKNOWN) {
        text += UNK_SURFACE;
        continue;
      }
      let piece = this.#pieces[id];
      if (text === "" && piece.startsWith(SPACE)) piece = piece.slice(SPACE.length);
      text += piece.replaceAll(SPACE, " ");
    }
    if (bytes.length) text += decodeUtf8Bytes(bytes);
    return text;
  }

  #check(id: number): void {
    if (!Number.isInteger(id) || id < 0 || id >= this.#pieces.length) throw new RangeError(`cipetpet: token id ${id} is out of range [0, ${this.#pieces.length})`);
  }
}

const isTrail = (b: number) => (b & 0xc0) === 0x80;
const validCodepoint = (c: number) => c < 0xd800 || (c >= 0xe000 && c <= 0x10ffff);

/** sentencepiece's UTF-8 decoding of a byte run (util.cc DecodeUTF8): an invalid byte -> one U+FFFD */
export function decodeUtf8Bytes(b: readonly number[]): string {
  let out = "";
  let i = 0;
  while (i < b.length) {
    const c0 = b[i];
    const left = b.length - i;
    let cp = -1;
    let len = 1;
    if (c0 < 0x80) {
      cp = c0;
    } else if (left >= 2 && (c0 & 0xe0) === 0xc0) {
      const c = ((c0 & 0x1f) << 6) | (b[i + 1] & 0x3f);
      if (isTrail(b[i + 1]) && c >= 0x80 && validCodepoint(c)) [cp, len] = [c, 2];
    } else if (left >= 3 && (c0 & 0xf0) === 0xe0) {
      const c = ((c0 & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      if (isTrail(b[i + 1]) && isTrail(b[i + 2]) && c >= 0x800 && validCodepoint(c)) [cp, len] = [c, 3];
    } else if (left >= 4 && (c0 & 0xf8) === 0xf0) {
      const c = ((c0 & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      if (isTrail(b[i + 1]) && isTrail(b[i + 2]) && isTrail(b[i + 3]) && c >= 0x10000 && validCodepoint(c)) [cp, len] = [c, 4];
    }
    out += cp < 0 ? "�" : String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

// Python's str.strip() whitespace (str.isspace): unlike String.prototype.trim it includes U+001C..U+001F
// and U+0085, and excludes U+FEFF, which is a piece of this vocabulary.
const PY_SPACE = new Set(
  [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]
    .concat(Array.from({ length: 11 }, (_, i) => 0x2000 + i)),
);

/** Python's str.strip() */
export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && PY_SPACE.has(s.charCodeAt(a))) a++;
  while (b > a && PY_SPACE.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}
