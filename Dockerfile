
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package.json ./package.json

RUN npm install --omit=dev

RUN npx playwright install --with-deps chromium

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
