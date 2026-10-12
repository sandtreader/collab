# Standalone relay image.
#   docker build -t collab-relay .
#   docker run -d -p 2901:2901 collab-relay

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile
COPY src src
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S collab && adduser -S collab -G collab
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER collab
EXPOSE 2901
CMD ["node", "dist/server/bin.js"]
