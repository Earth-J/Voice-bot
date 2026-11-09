# Earth Voice Bot — Railway / Docker image
# Debian (glibc) base: ffmpeg-static and sodium-native ship Linux glibc binaries.
FROM oven/bun:1-debian

WORKDIR /app
ENV NODE_ENV=production

# ── Native Opus (important) ────────────────────────────────────────────────────
# The listener needs @discordjs/opus (native). The fallback, opusscript (WASM), aborts
# on Bun as soon as 3 decoders are alive at once — see scripts/opus-stress.ts.
#
# Why `bun install` could not get it here: @discordjs/opus downloads a prebuilt named after
# the machine's REAL glibc version (…-linux-x64-glibc-2.41.tar.gz). v0.10.0 only publishes
# glibc 2.31 and 2.35, so Debian 12/13 gets HTTP 404, it then tries to compile, there is no
# compiler, the install script fails and Bun deletes the optional package
# ("Cannot find module '@discordjs/opus'"). Node / ABI tricks do not help with that.
#
# Fix: install with --ignore-scripts (the package stays on disk), then
#   * ffmpeg-static's install.js downloads its ffmpeg binary, and
#   * scripts/fetch-opus-prebuilt.mjs puts the published glibc-2.31 build (N-API, so it
#     works on Bun and on newer glibc) exactly where Bun's loader looks for it.
# No Node.js is needed in the image any more.
COPY package.json bun.lock ./
COPY scripts ./scripts
# Do NOT add --omit=optional: Discord voice needs optional native packages
# (e.g. @snazzah/davey-linux-x64-gnu) and the bot would crash at startup.
RUN bun install --frozen-lockfile --production --ignore-scripts \
 && bun node_modules/ffmpeg-static/install.js \
 && ./node_modules/ffmpeg-static/ffmpeg -version | head -1 \
 && bun scripts/fetch-opus-prebuilt.mjs \
 && bun -e "const { OpusEncoder } = require('@discordjs/opus'); new OpusEncoder(48000, 2); console.log('native opus OK under bun, ABI', process.versions.modules)"

COPY tsconfig.json ./
COPY src ./src
# Status sound effects (.mp3) — see sounds/README.txt
COPY sounds ./sounds

# Refuse to start on the unsafe WASM fallback instead of silently going deaf with 3 speakers.
# (Override with OPUS_REQUIRE_NATIVE=false in Railway only for a short experiment.)
ENV OPUS_REQUIRE_NATIVE=true

# Set REGISTER_COMMANDS_ON_START=true for ONE deploy to (re)register slash commands.
# `exec` makes bun PID 1 so Railway's SIGTERM triggers the bot's graceful shutdown.
CMD ["sh", "-c", "if [ \"$REGISTER_COMMANDS_ON_START\" = \"true\" ]; then bun src/register-commands.ts || echo '[start] command registration failed — continuing'; fi; exec bun src/index.ts"]
