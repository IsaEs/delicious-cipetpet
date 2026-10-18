// Reads the vocabulary out of a SentencePiece model file (a serialized sentencepiece.ModelProto) without
// the sentencepiece library. Only the parts the browser tokenizer needs: each piece and its type.
//
//   message ModelProto     { repeated SentencePiece pieces = 1; ... }
//   message SentencePiece  { optional string piece = 1; optional float score = 2; optional Type type = 3 [default = NORMAL]; }
//   enum Type { NORMAL = 1; UNKNOWN = 2; CONTROL = 3; USER_DEFINED = 4; BYTE = 6; UNUSED = 5; }

export const PieceType = { NORMAL: 1, UNKNOWN: 2, CONTROL: 3, USER_DEFINED: 4, UNUSED: 5, BYTE: 6 } as const;

export interface SpmPiece {
  piece: string;
  score: number;
  type: number;
}

class ProtoReader {
  pos: number;
  constructor(readonly buf: Uint8Array, start = 0, readonly end = buf.byteLength) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    // values here (tags, lengths, enums) fit in 53 bits; multiply instead of shifting past 31 bits
    let v = 0, mul = 1, b: number;
    do {
      if (this.pos >= this.end) throw new Error("spm: truncated varint");
      b = this.buf[this.pos++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  }

  /** advance past a field of the given wire type; returns [start, end) of a length-delimited payload */
  skip(wire: number): [number, number] {
    const start = this.pos;
    switch (wire) {
      case 0: this.varint(); break;
      case 1: this.pos += 8; break;
      case 2: {
        const len = this.varint();
        const s = this.pos;
        this.pos += len;
        if (this.pos > this.end) throw new Error("spm: truncated field");
        return [s, this.pos];
      }
      case 5: this.pos += 4; break;
      default: throw new Error(`spm: unsupported wire type ${wire}`);
    }
    if (this.pos > this.end) throw new Error("spm: truncated field");
    return [start, this.pos];
  }
}

/** The pieces of a SentencePiece model, in id order. */
export function parseSpm(model: Uint8Array): SpmPiece[] {
  const r = new ProtoReader(model);
  const dv = new DataView(model.buffer, model.byteOffset, model.byteLength);
  // ignoreBOM: a piece may be exactly U+FEFF, which the decoder would otherwise strip as a byte-order mark
  const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const pieces: SpmPiece[] = [];
  while (!r.done) {
    const tag = r.varint();
    const [s, e] = r.skip(tag & 7);
    if (tag >>> 3 !== 1 || (tag & 7) !== 2) continue; // trainer_spec, normalizer_spec, ... are not needed
    const p = new ProtoReader(model, s, e);
    const sp: SpmPiece = { piece: "", score: 0, type: PieceType.NORMAL };
    while (!p.done) {
      const t = p.varint();
      const field = t >>> 3, wire = t & 7;
      if (field === 3 && wire === 0) {
        sp.type = p.varint();
        continue;
      }
      const [a, b] = p.skip(wire);
      if (field === 1 && wire === 2) sp.piece = dec.decode(model.subarray(a, b));
      else if (field === 2 && wire === 5) sp.score = dv.getFloat32(a, true);
    }
    pieces.push(sp);
  }
  if (!pieces.length) throw new Error("spm: no pieces found (not a SentencePiece model?)");
  return pieces;
}
