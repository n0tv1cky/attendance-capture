// Deep-merges config.local.json (gitignored, real sheet/folder ids, real
// email, real Zoom credentials) over the committed config.json (placeholder
// values only) if a local override file exists next to the config being
// loaded. Lets config.json stay safe to publish while config.local.json
// supplies the values that actually make the tool work on this machine.
import fs from "node:fs";
import path from "node:path";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = isPlainObject(base[key]) && isPlainObject(override[key]) ? deepMerge(base[key], override[key]) : override[key];
  }
  return out;
}

export function mergeLocalConfig(configDir, raw) {
  const localPath = path.join(configDir, "config.local.json");
  if (!fs.existsSync(localPath)) return raw;
  const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
  return deepMerge(raw, local);
}
