# Lavalink service for Railway (set this service's Root Directory to /lavalink).
FROM ghcr.io/lavalink-devs/lavalink:4

COPY application.yml /opt/Lavalink/application.yml

# JVM heap. 512m is enough for one guild; raise via the _JAVA_OPTIONS variable on Railway if you see OutOfMemory.
ENV _JAVA_OPTIONS="-Xmx512m"

EXPOSE 2333
