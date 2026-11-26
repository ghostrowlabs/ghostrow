import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

declare const __GHOSTROW_BUNDLED__: boolean | undefined;

type Ort = typeof import("onnxruntime-node");

let loaded: Promise<Ort> | null = null;

/**
 * Load ONNX Runtime. A built CLI (npm bundle or standalone executable) carries the runtime's
 * JavaScript but not its native library: `ghostrow model pull` puts the library for this
 * platform next to the model, and it is loaded from there with process.dlopen (which works
 * inside a single executable application too). An unbundled source run uses node_modules.
 */
export function loadOrt(runtimeDir: string): Promise<Ort> {
  loaded ??= (async () => {
    if (typeof __GHOSTROW_BUNDLED__ === "boolean" && __GHOSTROW_BUNDLED__) {
      // A full path with native separators: Windows then loads onnxruntime.dll from the same folder.
      const binding = resolve(join(runtimeDir, "onnxruntime_binding.node"));
      if (!existsSync(binding)) throw new Error("the model runtime for this platform isn't installed");
      (globalThis as { __ghostrowOrtBinding?: () => unknown }).__ghostrowOrtBinding = () => {
        const m = { exports: {} as unknown };
        process.dlopen(m as NodeJS.Module, binding);
        return m.exports;
      };
    }
    const ort = (await import("onnxruntime-node")) as Ort & { default?: Ort };
    return ort.InferenceSession ? ort : ort.default!;
  })();
  return loaded;
}
