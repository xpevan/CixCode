import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const seaDir = path.join(root, "dist-sea");
const outputDir = path.join(root, "dist-bin");
const bundlePath = path.join(seaDir, "cli.cjs");
const blobPath = path.join(seaDir, "sea-prep.blob");
const outputName = process.platform === "win32" ? "cixcode.exe" : "cixcode";
const outputPath = path.join(outputDir, outputName);
const postjectCli = require.resolve("postject/dist/cli.js");
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

rmSync(seaDir, { recursive: true, force: true });
mkdirSync(seaDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

execFileSync(
  process.execPath,
  ["--experimental-sea-config", "sea-config.json"],
  { cwd: root, stdio: "inherit" },
);

rmSync(outputPath, { force: true });
copyFileSync(process.execPath, outputPath);

if (process.platform === "darwin") {
  execFileSync("codesign", ["--remove-signature", outputPath], {
    stdio: "inherit",
  });
}

execFileSync(
  process.execPath,
  [
    postjectCli,
    outputPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    seaFuse,
  ],
  { cwd: root, stdio: "inherit" },
);

if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", outputPath], {
    stdio: "inherit",
  });
}

console.log(`Built ${outputPath}`);
