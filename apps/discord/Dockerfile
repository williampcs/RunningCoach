# 自建用的 Discord bot（v2）。建置時以 repo 根目錄為 context：
#
#   docker build -f apps/discord/Dockerfile -t running-coach-bot .
#   docker run -d --env-file .env -v "$PWD/data:/app/data" running-coach-bot

# 所有 workspace 的 package.json 都要在場，npm ci 才認得 lockfile
FROM node:22-slim AS manifests
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/sqlite-node/package.json packages/sqlite-node/
COPY apps/discord/package.json apps/discord/
COPY apps/proxy/package.json apps/proxy/
COPY apps/web/package.json apps/web/

FROM manifests AS build
RUN npm ci --workspace @running-coach/discord --include-workspace-root
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/discord ./apps/discord
RUN npm run build --workspace @running-coach/discord

# 執行階段只需要沒被打包進去的兩個套件（better-sqlite3、discord.js）
FROM manifests AS deps
RUN npm ci --omit=dev --workspace @running-coach/discord

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/discord/dist ./apps/discord/dist
RUN mkdir -p /app/data
CMD ["node", "apps/discord/dist/main.js"]
