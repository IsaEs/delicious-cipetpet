// Resolution target for "cipetpet" in tests (see vitest.config.ts). Every test file replaces it with
// vi.mock("cipetpet", () => import("./fake-core.js")); reaching this module means a test forgot the mock.
const missing = (): never => {
  throw new Error('cipetpet-react tests: "cipetpet" is not mocked in this test file');
};
export const AntaliaMini = { load: missing };
export const DuyuSmall = { load: missing };
export const createAntaliaWorker = missing;
export const createTtsWorker = missing;
export const loadTextToSpeech = missing;
export const createDuyuWorker = missing;
export const MicRecorder = { start: missing };
export class StreamPlayer {
  constructor() {
    missing();
  }
}
export const encodeWav = missing;
export const decodeAudio = missing;
