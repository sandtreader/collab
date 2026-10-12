# Standalone relay image.
#   docker build -t collab-relay https://github.com/sandtreader/collab.git#v0.1.2
#   docker run -d -p 2901:2901 collab-relay

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY src src
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S collab && adduser -S collab -G collab
COPY --from=build /app/dist ./dist
# The relay's only runtime dependency is ws, declared as an optional peer so
# browser consumers don't pull it in. A minimal ESM package.json (the dist
# files are ES modules) plus ws alone is the whole runtime.
RUN echo '{"name":"collab-relay","private":true,"type":"module"}' > package.json \
    && npm install --no-package-lock --ignore-scripts ws@^8.20.0 \
    && npm cache clean --force
USER collab
EXPOSE 2901
CMD ["node", "dist/server/bin.js"]
