// esbuild plugin: bundle onnxruntime-node's JavaScript but not its native library. Its
// `require("../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node")` becomes a call to the
// loader in src/model/runtime.ts, which opens the library `ghostrow model pull` installed.
import { readFile } from "node:fs/promises";

const NATIVE = "require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)";

export const ortPlugin = {
  name: "ghostrow-ort",
  setup(build) {
    build.onLoad({ filter: /binding\.js$/ }, async (args) => {
      if (!args.path.split("\\").join("/").endsWith("onnxruntime-node/dist/binding.js")) return undefined;
      const src = await readFile(args.path, "utf8");
      if (!src.includes(NATIVE)) throw new Error("onnxruntime-node's binding.js changed shape; update scripts/ort-plugin.mjs");
      return { contents: src.replace(NATIVE, "globalThis.__ghostrowOrtBinding()"), loader: "js" };
    });
  },
};
