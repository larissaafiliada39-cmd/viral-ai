
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package.json ./package.json

RUN npm install --omit=dev

# Instala o Chromium em modo headless e suas dependências.
RUN npx playwright install --with-deps --only-shell chromium

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
