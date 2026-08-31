# NestJS backend — Cloud Run / Docker Hub / local compose.
#
# Build (from this directory):
#   docker build -t backend .
#
# Migrate job (optional Cloud Run Job):
#   docker build -f Dockerfile.migrate -t backend-migrate .

FROM node:18-alpine AS base

RUN apk add --no-cache openssl openssl-dev libc6-compat
RUN npm install -g pnpm@10.18.2

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY prisma ./prisma
RUN pnpm prisma:generate

COPY . .
RUN pnpm build

FROM node:18-alpine

RUN apk add --no-cache openssl openssl-dev libc6-compat
RUN npm install -g pnpm@10.18.2 prisma@^5.20.0

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=base /app/prisma ./prisma
RUN pnpm prisma:generate

COPY --from=base /app/dist ./dist
COPY --from=base /app/proto ./proto

RUN mkdir -p storage/egress/audio storage/egress/video storage/pipeline-logs

# HTTP/WS (Cloud Run injeta PORT; default local/container 8080)
EXPOSE 8080
# gRPC feedback ingress (Envoy routes application/grpc here)
EXPOSE 50052

ENV NODE_ENV=production
ENV GRPC_FEEDBACK_PORT=50052

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3001) + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["pnpm", "start:prod"]
