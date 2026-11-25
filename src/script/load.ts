import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { DemoConfigError, type DemoDefinition } from "./api.js";
import { loadYamlDemo } from "./yaml.js";

/** The package's own entry point, so a script's `import "demokiln"` works even without a local install. */
function selfEntry(): string {
  for (const name of ["../index.js", "../index.ts"]) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error("Demokiln's entry file is missing.");
}

/** Loads a demo: a script (.ts, .js, .mjs) with a default export, or a plain steps file (.yaml, .yml). */
export async function loadScript(scriptPath: string): Promise<DemoDefinition> {
  const file = resolve(scriptPath);
  if (!existsSync(file)) throw new DemoConfigError(`No demo script at ${file}. Run "demokiln init" to create one.`);
  if (/\.ya?ml$/i.test(file)) return loadYamlDemo(file);
  const jiti = createJiti(import.meta.url, { alias: { demokiln: selfEntry() }, moduleCache: false });
  const loaded = (await jiti.import(file, { default: true })) as Partial<DemoDefinition> | undefined;
  if (!loaded || loaded.__demokiln !== 1 || typeof loaded.run !== "function") {
    throw new DemoConfigError(`${file} must have a default export created with demo({...}, async ({ page, step }) => {...}).`);
  }
  return loaded as DemoDefinition;
}
