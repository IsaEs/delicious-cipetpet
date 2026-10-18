// loadTextToSpeech: whichever text-to-speech model a pack holds, by the model id in its header.
//
//   const tts = await loadTextToSpeech(url);       // AntaliaMini for an antalia-mini pack, EmaLightning for ema-lightning
//   for await (const chunk of tts.stream("Merhaba!")) player.push(chunk.audio);
//
// Both classes take SynthesisOptions and give SpeechChunk / SynthesisResult; `tts.info.id` tells them apart.

import { AntaliaMini } from "./antalia/index.js";
import { EmaLightning } from "./ema/index.js";
import { openPack } from "./pack/reader.js";
import type { PackSource } from "./pack/types.js";
import type { LoadOptions } from "./types.js";

/** A loaded text-to-speech model. */
export type TextToSpeechModel = AntaliaMini | EmaLightning;

/** The text-to-speech model ids loadTextToSpeech knows. */
export const TTS_MODEL_IDS = ["antalia-mini", "ema-lightning"] as const;
export type TtsModelId = (typeof TTS_MODEL_IDS)[number];

/** Opens the pack and loads the model its header names. A pack of any other model fails with AntaliaMini's
 * error, which names the class to use. `expect` makes a pack of the other TTS model fail too. */
export async function loadTextToSpeech(source: PackSource, opts: LoadOptions = {}, expect?: TtsModelId): Promise<TextToSpeechModel> {
  const pack = await openPack(source, opts);
  const id = expect ?? pack.model.id;
  return id === "ema-lightning" ? EmaLightning.load(pack, opts) : AntaliaMini.load(pack, opts);
}
