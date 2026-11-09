/**
 * Make the native @discordjs/opus binary loadable under Bun (Windows / macOS / Linux).
 *
 * Why: @discordjs/opus looks for  prebuild/node-v<ABI>-napi-v3-<platform>-<arch>-<libc>/opus.node
 * where <ABI> is whatever runtime asks. Bun reports its own number (e.g. 147), but the
 * prebuilt binaries are published for Node's numbers (e.g. 127), so under Bun the file is
 * "not found" and the bot silently fell back to opusscript (WASM) — which stress tests showed
 * aborting with 3+ simultaneous decoders (scripts/opus-stress.ts).
 *
 * The binaries are N-API v3, which is ABI-stable across runtimes, so the SAME file works —
 * it only needs to sit under the name Bun searches for. This script copies it there.
 * (A copy, not a symlink: symlinks need admin rights on Windows.)
 *
 * Run by `postinstall` and by the Dockerfile. Idempotent; never fails the install.
 *   bun scripts/fix-opus-abi.mjs
 * Override the target ABI (testing): OPUS_ABI=147 node scripts/fix-opus-abi.mjs
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prebuildDir = join(root, "node_modules", "@discordjs", "opus", "prebuild");
const ABI = process.env.OPUS_ABI || process.versions.modules;

function main() {
  if (!ABI) return console.log("[fix-opus-abi] runtime reports no ABI (process.versions.modules) — skip");
  if (!existsSync(prebuildDir)) {
    return console.log(`[fix-opus-abi] ${prebuildDir} missing — @discordjs/opus not installed or has no prebuild, skip`);
  }

  // node-v127-napi-v3-linux-x64-glibc  →  version number + the rest
  const re = /^node-v(\d+)-(napi-v\d+-.+)$/;
  const found = readdirSync(prebuildDir)
    .map((name) => ({ name, m: re.exec(name) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, abi: Number(x.m[1]), rest: x.m[2] }));

  if (found.length === 0) return console.log("[fix-opus-abi] no node-v*-napi-v* prebuild found — nothing to copy");

  // Highest version first; skip if the runtime's own name already exists for that platform suffix.
  found.sort((a, b) => b.abi - a.abi);
  const src = found[0];
  const targetName = `node-v${ABI}-${src.rest}`;
  if (found.some((f) => f.name === targetName)) {
    return console.log(`[fix-opus-abi] ${targetName} already present — nothing to do`);
  }

  cpSync(join(prebuildDir, src.name), join(prebuildDir, targetName), { recursive: true });
  console.log(`[fix-opus-abi] copied ${src.name} → ${targetName}`);
}

try {
  main();
} catch (e) {
  // Never break `bun install`; the Docker build verifies the result separately.
  console.warn("[fix-opus-abi] failed (ignored):", e?.message ?? e);
}
