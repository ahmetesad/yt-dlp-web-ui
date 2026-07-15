FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip \
    && python3 -m pip install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src

RUN mkdir -p /app/downloads && chown node:node /app/downloads

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

USER node

EXPOSE 3000
VOLUME ["/app/downloads"]

CMD ["npm", "start"]
