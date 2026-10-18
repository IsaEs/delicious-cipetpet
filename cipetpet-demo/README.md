# cipetpet-demo

A spoken conversation with an AI model, in the browser: you speak, **Duyu-small** writes down what you said, a language
model answers (through OpenRouter or any OpenAI-compatible API), and **Antalia-2 Mini** or **EMA Lightning** speaks the
answer. The voice models run on your device.

There are two ways to run it:

| | what it is | API keys |
|---|---|---|
| **Local server** (`npm run dev`) | a small Node server serves the page, the packs and an `/api/chat` proxy | stay on the server, in `.env.local` |
| **Static site** (`npm run build:pages`) | plain files for GitHub Pages or any static host | none: echo mode, or you type your own key |

## Run it locally

From the repository root (see the [root README](../README.md#run-the-demo) for all steps):

```sh
cd cipetpet && npm install && npm run build && npm run packs
cd ../cipetpet-demo && npm install
cp -n .env.example .env.local     # put your keys in it (never commit it)
npm run dev                       # http://127.0.0.1:5173
```

To try the voice loop without a key, choose the echo backend in Settings.

## Chat providers

Every provider speaks the OpenAI chat completions API (`POST <base>/chat/completions` with streaming, `GET <base>/models`).

**Through the server (proxy, the keys stay on the server).** `.env.local` (see `.env.example`) can name OpenRouter and any
number of OpenAI-compatible APIs; with more than one, Settings → Provider picks the one to use, and the model list comes
from that provider (`/api/models`, asked with its key):

```sh
OPENROUTER_API_KEY=sk-or-...           # optional
LLM_PROVIDERS=ollama,groq              # ids of your choice
LLM_OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
LLM_OLLAMA_MODEL=llama3.2              # used until the page picks another
LLM_OLLAMA_NAME=Ollama (local)
LLM_GROQ_BASE_URL=https://api.groq.com/openai/v1
LLM_GROQ_API_KEY=gsk_...
LLM_GROQ_MODEL=llama-3.3-70b-versatile
LLM_DEFAULT_PROVIDER=ollama            # default: OpenRouter when it has a key, else the first listed
```

The server prints the providers it found at start (never the keys). A provider without `LLM_<ID>_MODEL` works once the
page names a model.

**From the browser (direct).** Settings → Connection → Direct: OpenRouter, or "+ Add an OpenAI-compatible API" with its
base URL (e.g. `https://api.openai.com/v1`, `http://localhost:11434/v1`), an optional key and a model. Keys are kept
per provider, in memory unless you tick "remember"; the endpoints themselves are saved with the settings (not in the
conversation export). The API must allow requests from the page's origin (CORS): hosted APIs mostly do, Ollama needs
`OLLAMA_ORIGINS`, LM Studio has a CORS switch.

## Voice models

Settings → Speech synthesis → Voice model switches between **Antalia-2 Mini** (`antalia-mini-mixed.cpet`, ~23 MB) and
**EMA Lightning** (`ema-lightning-fp32.cpet`, ~34 MB). The EMA Lightning pack is built from ema-lightning-web's export
(`npm run packs -- --only ema-lightning-fp32 --ema ../ema-lightning-web/web` in `../cipetpet`); the page marks a voice
whose pack the server does not have.

## Host it as a static site

`npm run build:pages` writes a complete static site into `pages/`:

- the built app, and `coi-sw.js`, a small service worker that adds the `COOP`/`COEP` headers that hosts like GitHub Pages
  cannot send (without them the models run on one thread instead of four),
- the model packs and the ONNX Runtime files, **pulled from this project's GitHub Release** of the version in
  `cipetpet/package.json` (`cipetpet pull`, every file checked against the release's hashes); they are not in git.
  `--packs-dir ../cipetpet/packs` takes them from your local build instead (with the EMA Lightning pack, when it is
  there),
- `api/config`, a static copy of what the demo server answers (`proxy: false` and the packs' integrity hashes, so a
  browser keeps its downloaded copy and checks it),
- `LICENSE` and `NOTICE` (credits for the models and ONNX Runtime).

Serve that folder from the root of a host. It must be served over **HTTPS** (service workers and the microphone only
work on secure pages) and from the root of its own host name, because the page's asset paths are absolute.
`.github/workflows/pages.yml` does the build and the deployment for GitHub Pages.

There is no chat proxy and no key on a static site, so it has two modes: the offline **echo** mode (the voice loop
works, the reply repeats what was heard) and **direct** mode, where you paste your own OpenRouter key, or add an
OpenAI-compatible API, in Settings. The key stays in your browser and is only remembered if you tick "remember".

Threads need a cross-origin isolated page. The service worker makes the page isolated after one automatic reload on
the first visit. Where that cannot happen (a browser without service workers, a hard reload that bypasses it) the page
still starts, on one thread. Firefox and Safari have not been tested with it.

## Scripts

| | |
|---|---|
| `npm run dev` | build (unminified) and serve with the local server, rebuilding on change |
| `npm run build` | production build into `dist/` |
| `npm run build:pages` | static site into `pages/` (`--packs-dir DIR`, `--tag vX.Y.Z`, `--no-build`) |
| `npm start` | serve `dist/` with the local server |
| `npm run typecheck`, `npm test` | checks |
