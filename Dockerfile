FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3-slim
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/pressbot.sqlite
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
VOLUME /app/data
EXPOSE 3000
CMD ["bun", "run", "server/index.ts"]
