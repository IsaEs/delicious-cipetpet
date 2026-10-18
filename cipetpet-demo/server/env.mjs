// A tiny .env parser (no dependency): KEY=VALUE lines, optional "export ", # comments, single / double quotes
// (double quotes understand \n, \t, \", \\). Real environment variables always win over the file.

import { readFileSync } from "node:fs";

/** @param {string} text @returns {Record<string, string>} */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1) < 0 ? -1 : findClosingQuote(value);
      value = end < 0 ? value.slice(1) : value.slice(1, end);
      value = value.replace(/\\([nrt"\\])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c]);
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end < 0 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** @param {string} v */
function findClosingQuote(v) {
  for (let i = 1; i < v.length; i++) {
    if (v[i] === "\\") i++;
    else if (v[i] === '"') return i;
  }
  return -1;
}

/**
 * process.env over the values of `file` (when it exists).
 * @param {string | null} file
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {{ env: Record<string, string | undefined>, loadedFile: boolean }}
 */
export function loadEnv(file, base = process.env) {
  let fromFile = {};
  let loadedFile = false;
  if (file) {
    try {
      fromFile = parseEnv(readFileSync(file, "utf8"));
      loadedFile = true;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
    }
  }
  /** @type {Record<string, string | undefined>} */
  const env = { ...fromFile };
  for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== "") env[k] = v;
  return { env, loadedFile };
}
