# NestJS farm-backend — HTTP only (sem gRPC / proto).
#
# Build (from this directory):
#   docker build -t farm-backend .

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

EXPOSE 8080

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["pnpm", "start:prod"]
