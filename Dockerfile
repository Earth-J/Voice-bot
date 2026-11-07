# Earth Voice Bot — Railway / Docker image
# Debian (glibc) base: ffmpeg-static and sodium-native ship Linux glibc binaries.
FROM oven/bun:1-debian

WORKDIR /app
ENV NODE_ENV=production

# Install deps first (better layer caching).
# scripts/ is needed because package.json has a postinstall hook.
# NOTE: @discordjs/opus is an *optional* dependency. On Linux it may fail to
# install (no prebuilt binary / no compiler) — you can see harmless gyp errors in
# the build log. That is fine: prism-media then falls back to opusscript.
# Do NOT add --omit=optional: Discord voice needs optional native packages
# (e.g. @snazzah/davey-linux-x64-gnu) and the bot would crash at startup.
COPY package.json bun.lock ./
COPY scripts ./scripts
RUN bun install --frozen-lockfile --production \
 && ./node_modules/ffmpeg-static/ffmpeg -version | head -1

COPY tsconfig.json ./
COPY src ./src
# Status sound effects (.mp3) — see sounds/README.txt
COPY sounds ./sounds

# Set REGISTER_COMMANDS_ON_START=true for ONE deploy to (re)register slash commands.
# `exec` makes bun PID 1 so Railway's SIGTERM triggers the bot's graceful shutdown.
CMD ["sh", "-c", "if [ \"$REGISTER_COMMANDS_ON_START\" = \"true\" ]; then bun src/register-commands.ts || echo '[start] command registration failed — continuing'; fi; exec bun src/index.ts"]
