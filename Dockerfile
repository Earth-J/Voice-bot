# Earth Voice Bot — Railway / Docker image
# Debian (glibc) base: ffmpeg-static and sodium-native ship Linux glibc binaries.
FROM oven/bun:1-debian

WORKDIR /app
ENV NODE_ENV=production

# ── Native Opus (important) ────────────────────────────────────────────────────
# The listener needs @discordjs/opus (native). The fallback, opusscript (WASM), aborts
# on Bun as soon as 3 decoders are alive at once — see scripts/opus-stress.ts.
#
# Why it used to fail to install here: during `bun install` this image has no real
# Node, so Bun's own ABI number is used when @discordjs/opus's install script asks for a
# prebuilt binary. None is published for that number, it tries to compile, there is no
# compiler, and the "harmless gyp error" in the log was in fact the missing binary.
#
# Fix: give the install a real Node 22 (binaries exist for it), then
# scripts/fix-opus-abi.mjs copies that binary to the ABI name Bun looks for (the
# binary is N-API v3, which is ABI-stable across runtimes). Node is removed afterwards;
# the bot itself still runs on Bun.
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

# Install deps first (better layer caching).
# scripts/ is needed because package.json has a postinstall hook.
# Do NOT add --omit=optional: Discord voice needs optional native packages
# (e.g. @snazzah/davey-linux-x64-gnu) and the bot would crash at startup.
COPY package.json bun.lock ./
COPY scripts ./scripts
RUN bun install --frozen-lockfile --production \
 && ./node_modules/ffmpeg-static/ffmpeg -version | head -1 \
 && bun scripts/fix-opus-abi.mjs \
 && bun -e "const { OpusEncoder } = require('@discordjs/opus'); new OpusEncoder(48000, 2); console.log('native opus OK under bun, ABI', process.versions.modules)" \
 && rm -f /usr/local/bin/node

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
