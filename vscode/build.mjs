import { build } from "esbuild";
import { resolve } from "node:path";

await build({
  entryPoints: ["vscode/src/extension.ts"],
  outfile: "vscode/out/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  define: { __JEV_DEFAULT_ENV_FILE__: JSON.stringify(resolve(".env")) },
  sourcemap: false,
  logLevel: "info",
});
