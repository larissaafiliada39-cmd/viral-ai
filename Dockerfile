FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/package.json ./package.json
RUN npm install --omit=dev
COPY backend ./backend
COPY public ./public
RUN mkdir -p /app/data
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
EXPOSE 3000
CMD ["node", "backend/server.js"]
