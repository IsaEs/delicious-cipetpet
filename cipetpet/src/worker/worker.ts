import { AntaliaMini } from "../antalia/index.js";
import { DuyuSmall } from "../duyu/index.js";
import type { LoadOptions } from "../types.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

type LoadedModel = AntaliaMini | DuyuSmall;

const scope = globalThis as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
};
const controllers = new Map<number, AbortController>();
let model: LoadedModel | null = null;
let kind: "tts" | "stt" | null = null;

function send(message: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function sendError(id: number, error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error));
  send({ type: "error", id, name: e.name, message: e.message, stack: e.stack });
}

async function handle(request: WorkerRequest): Promise<void> {
  if (request.type === "cancel") {
    controllers.get(request.id)?.abort();
    return;
  }
  if (request.type === "load") {
    const controller = new AbortController();
    controllers.set(request.id, controller);
    try {
      if (model) throw new Error("cipetpet: worker model is already loaded");
      const options: LoadOptions = {
        ...request.options,
        signal: controller.signal,
        onProgress: (progress) => send({ type: "progress", id: request.id, progress }),
      };
      model =
        request.kind === "tts"
          ? await AntaliaMini.load(request.source, options)
          : await DuyuSmall.load(request.source, options);
      kind = request.kind;
      send({
        type: "loaded",
        id: request.id,
        info: model.info,
        defaults: request.kind === "tts" ? (model as AntaliaMini).defaults : undefined,
      });
    } catch (error) {
      sendError(request.id, error);
    } finally {
      controllers.delete(request.id);
    }
    return;
  }

  if (request.type === "dispose") {
    try {
      await model?.dispose();
      model = null;
      kind = null;
      send({ type: "result", id: request.id });
    } catch (error) {
      sendError(request.id, error);
    }
    return;
  }

  const active = model;
  const activeKind = kind;
  if (!active || !activeKind) {
    sendError(request.id, new Error("cipetpet: worker model is not loaded"));
    return;
  }
  const controller = new AbortController();
  controllers.set(request.id, controller);
  try {
    const [arg, options] = request.args;
    if (activeKind === "tts" && request.method === "normalize") {
      send({ type: "result", id: request.id, value: await (active as AntaliaMini).normalize(String(arg)) });
    } else if (activeKind === "tts" && request.method === "synthesize") {
      const result = await (active as AntaliaMini).synthesize(String(arg), {
        ...(options as object),
        signal: controller.signal,
      });
      send({ type: "result", id: request.id, value: result }, [result.audio.buffer]);
    } else if (activeKind === "tts" && request.method === "stream") {
      for await (const chunk of (active as AntaliaMini).stream(String(arg), {
        ...(options as object),
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        send({ type: "chunk", id: request.id, chunk }, [chunk.audio.buffer]);
      }
      send({ type: "result", id: request.id });
    } else if (activeKind === "stt" && request.method === "transcribe") {
      const audio = arg as Float32Array;
      const result = await (active as DuyuSmall).transcribe(audio, {
        ...(options as object),
        signal: controller.signal,
      });
      send({ type: "result", id: request.id, value: result });
    } else {
      throw new Error(`cipetpet: ${request.method} is not available for the ${activeKind} model`);
    }
  } catch (error) {
    sendError(request.id, error);
  } finally {
    controllers.delete(request.id);
  }
}

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
});
