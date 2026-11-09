/**
 * Fetch a working native @discordjs/opus binary for Docker / Railway (Linux x64, glibc).
 *
 * Why this exists
 * ---------------
 * @discordjs/opus's install script (`node-pre-gyp install --fallback-to-build`) downloads
 *   opus-v<ver>-node-v<ABI>-napi-v3-linux-x64-glibc-<GLIBC_VERSION>.tar.gz
 * where <GLIBC_VERSION> is the REAL glibc version of the machine doing the install.
 * v0.10.0 only publishes glibc 2.31 and 2.35 builds. Debian 12 (glibc 2.36) and
 * Debian 13 (glibc 2.41) — what oven/bun:1-debian is based on — get HTTP 404, node-pre-gyp
 * then tries to compile from source, the image has no compiler, the install script fails and
 * Bun deletes the optional dependency. Result: "Cannot find module '@discordjs/opus'".
 *
 * The published binary is N-API v3 (ABI-stable across Node/Bun versions) and glibc is
 * forward-compatible, so the glibc-2.31 build runs fine on newer glibc. It only has to sit
 * under the directory name that the *runtime* (Bun) computes. We ask the loader itself
 * (`node-pre-gyp.find`) for that exact path instead of guessing ABI / glibc numbers.
 *
 * Usage (after `bun install --ignore-scripts`):
 *   bun scripts/fetch-opus-prebuilt.mjs
 * Env overrides: OPUS_PREBUILT_GLIBC (default 2.31), OPUS_PREBUILT_ABI (default 127),
 *                OPUS_PREBUILT_URL (full tarball URL).
 * Exits non-zero on failure so the Docker build stops instead of shipping a deaf bot.
 */
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const opusDir = join(root, "node_modules", "@discordjs", "opus");
const require = createRequire(join(root, "package.json"));
const log = (m) => console.log(`[opus-prebuilt] ${m}`);
const fail = (m) => {
  console.error(`[opus-prebuilt] ERROR: ${m}`);
  process.exit(1);
};

function nativeLoads() {
  try {
    const { OpusEncoder } = require("@discordjs/opus");
    new OpusEncoder(48_000, 2);
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(join(opusDir, "package.json"))) {
  fail(`${opusDir} not found — run \`bun install --ignore-scripts\` first (a failed install script makes Bun delete this optional package).`);
}

if (nativeLoads()) {
  log("native @discordjs/opus already loads — nothing to do");
  process.exit(0);
}

if (process.platform !== "linux" || process.arch !== "x64") {
  fail(`no automatic prebuilt for ${process.platform}-${process.arch}; this helper is for the Linux x64 Docker image`);
}

const pkg = JSON.parse(readFileSync(join(opusDir, "package.json"), "utf8"));
const abi = process.env.OPUS_PREBUILT_ABI || "127"; // Node 22; N-API v3 binary works on any ABI
const glibc = process.env.OPUS_PREBUILT_GLIBC || "2.31"; // oldest published build = most compatible
const url =
  process.env.OPUS_PREBUILT_URL ||
  `${pkg.binary.host}v${pkg.version}/opus-v${pkg.version}-node-v${abi}-napi-v3-linux-x64-glibc-${glibc}.tar.gz`;

// Where THIS runtime (Bun) will look for opus.node — ask the loader, don't guess.
const { find } = require("@discordjs/node-pre-gyp");
const target = find(join(opusDir, "package.json"));
log(`runtime ABI ${process.versions.modules} expects ${target}`);
log(`downloading ${url}`);

const res = await fetch(url, { redirect: "follow" });
if (!res.ok) fail(`HTTP ${res.status} for ${url}`);

const tmp = mkdtempSync(join(tmpdir(), "opus-"));
try {
  const tgz = join(tmp, "opus.tar.gz");
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  const x = spawnSync("tar", ["-xzf", tgz, "-C", tmp], { encoding: "utf8" });
  if (x.status !== 0) fail(`tar failed: ${x.stderr || x.error}`);

  // Tarball layout: <dir>/opus.node (or opus.node at the top level).
  const candidates = [join(tmp, "opus.node"), ...readdirSync(tmp).map((d) => join(tmp, d, "opus.node"))];
  const binary = candidates.find((p) => existsSync(p));
  if (!binary) fail("opus.node not found inside the downloaded archive");

  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(binary, target);
  log(`installed → ${target}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (!nativeLoads()) fail("binary copied but @discordjs/opus still fails to load on this runtime");
log(`native opus OK (runtime ABI ${process.versions.modules})`);
