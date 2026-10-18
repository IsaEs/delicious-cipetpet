import type { ModelInfo, SpeechChunk, SynthesisResult, TranscriptionResult } from "../types.js";
import type { PackProgress, PackSource } from "../pack/types.js";

export type WorkerKind = "tts" | "stt";
export type WorkerSource = Exclude<PackSource, import("../pack/reader.js").Pack>;

export type WorkerRequest =
  | { type: "load"; id: number; kind: WorkerKind; source: WorkerSource; options: Record<string, unknown> }
  | { type: "call"; id: number; method: "normalize" | "synthesize" | "stream" | "transcribe"; args: unknown[] }
  | { type: "cancel"; id: number }
  | { type: "dispose"; id: number };

export type WorkerResponse =
  | { type: "loaded"; id: number; info: ModelInfo; defaults?: { steps: number; cfg: number; speed: number; temperature: number } }
  | { type: "progress"; id: number; progress: PackProgress }
  | { type: "chunk"; id: number; chunk: SpeechChunk }
  | { type: "result"; id: number; value?: string | SynthesisResult | TranscriptionResult }
  | { type: "error"; id: number; name: string; message: string; stack?: string };
