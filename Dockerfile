FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/data/stats.db

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "dist/server/index.js"]
