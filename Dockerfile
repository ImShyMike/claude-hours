# The hub: built and run with bun (adapter-bun needs 1.4 or newer for both).
# Migrations run on every start, so a new database gets its tables and a
# deploy brings an old one up to date
FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && rm -rf node_modules && bun install --frozen-lockfile --production

FROM oven/bun:1.4.3-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 BODY_SIZE_LIMIT=4M PROTOCOL_HEADER=x-forwarded-proto HOST_HEADER=x-forwarded-host
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/build build
COPY --from=build /app/drizzle drizzle
COPY --from=build /app/scripts/migrate.js scripts/migrate.js
USER bun
EXPOSE 3000
# ./build, not build: `bun build` is bun's bundler
CMD ["sh", "-c", "bun scripts/migrate.js && bun ./build"]
