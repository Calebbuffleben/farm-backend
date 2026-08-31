<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

Backend para sistema de análise de chamadas do Google Meet, conectando com Chrome Extension via Socket.IO.

## Project setup

### Pré-requisitos

- Node.js 18+
- pnpm
- PostgreSQL (ou Docker)

### Instalação

1. Clone o repositório e entre na pasta backend:
```bash
cd backend
```

2. Instale as dependências:
```bash
pnpm install
```

3. Configure as variáveis de ambiente:
```bash
cp env .env
# Edite .env com suas configurações de banco de dados
```

4. Inicie o banco de dados (usando Docker):
```bash
docker-compose up -d postgres
```

5. Execute as migrations do Prisma:
```bash
pnpm prisma migrate deploy
# ou para desenvolvimento:
pnpm prisma migrate dev
```

6. Gere o Prisma Client:
```bash
pnpm prisma:generate
```

### Desenvolvimento

```bash
# Modo desenvolvimento (watch)
pnpm start:dev

# Modo produção
pnpm build
pnpm start:prod
```

### Docker

Para rodar o backend completo com Docker:

```bash
# Build da imagem
docker build -t meet-backend .

# Rodar com docker-compose (inclui PostgreSQL)
docker-compose up -d
```

O backend estará disponível em `http://localhost:3001`

### Socket.IO

O backend expõe um gateway Socket.IO na porta 3001 (ou PORT configurada).

**Multi-réplica (produção):** defina `REDIS_URL` (ex.: `redis://localhost:6379` ou URL do Redis gerenciado). O bootstrap em `main.ts` usa o adaptador `@socket.io/redis-adapter` para que o broadcast `feedback` alcance clientes conectados em qualquer instância. Sem `REDIS_URL`, o adaptador padrão é em memória (adequado para uma única réplica ou desenvolvimento).

**Eventos suportados:**
- `join-room`: Cliente se conecta a uma sala (ex: `feedback:meetingId`)
- `feedback`: Recebe eventos de feedback em tempo real

**Endpoints REST:**
- `GET /health`: Health check
- `GET /feedback/metrics/:meetingId`: Métricas de feedback de uma reunião

### Autenticação e multi-tenancy

O backend é multi-tenant com isolamento row-level e autenticação JWT.
Detalhes completos em [`docs/auth-architecture.md`](../docs/auth-architecture.md)
e [`docs/tenancy.md`](../docs/tenancy.md). Resumo:

- **Endpoints** (`AuthController`): `POST /auth/register`, `POST /auth/login`,
  `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`,
  `POST /auth/service-token` (protegido por `SERVICE_BOOTSTRAP_KEY`). Todos
  com rate limit dedicado via `@nestjs/throttler`.
- **Tokens**: RS256 em produção (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`), HS256
  (`JWT_SECRET`) somente fora de produção. Access curto, refresh rotativo com
  família (`RefreshToken.familyId` / `jti`). Tokens de serviço são globais
  (sem tenant obrigatório), cunhados via `POST /auth/service-token` com TTL
  clamped a `[60s, 6 × DEFAULT_SERVICE_TTL_SECONDS]` e registrados em
  `AuditLog`.
- **Guards globais**: `JwtAuthGuard` + `RolesGuard` via `APP_GUARD`. Endpoints
  públicos usam `@Public()`. O guard evita re-verificar o JWT quando o
  `TenantContextMiddleware` já populou `req.user`.
- **Lockout de login**: falhas `auth.login.fail` são contadas numa janela
  deslizante por `(tenantId, email)` e por IP. Ao atingir
  `AUTH_LOCKOUT_EMAIL_THRESHOLD` (5) ou `AUTH_LOCKOUT_IP_THRESHOLD` (20) o
  endpoint responde `401 Too many failed attempts`. Um login bem-sucedido
  reseta o contador e escreve `auth.login.ok`.
- **Tenancy**: para usuários humanos, `tenantId` sempre vem do JWT
  (`token.tid`). Middleware Prisma (`prisma-tenancy.middleware.ts`) injeta
  o filtro automaticamente;
  `x-tenant-id` do cliente é apenas hint redundante — validado no
  `TenantContextMiddleware` (HTTP), no gateway (Socket.IO), no upgrade
  (`/egress-audio`) e em `FeedbackGrpcServer.authenticate` (gRPC). Tokens
  `role=SERVICE` usados pelo Python são globais e exigem `x-tenant-id`
  obrigatório; o backend valida que esse tenant está ativo e o usa como
  tenant efetivo da chamada. Tenant mismatch é auditado com
  `action='tenant_mismatch'` e `target` transport-specific.
- **Hardening**: `helmet` + `ValidationPipe` global, `CORS_ORIGINS` allowlist
  obrigatório em produção (HTTP e Socket.IO), gRPC com TLS/mTLS
  (`GRPC_TLS_SERVER_CERT`, `GRPC_TLS_SERVER_KEY`, `GRPC_TLS_CLIENT_CA`).
  `createInsecure()` é recusado em produção.
- **Env adicionais** (nomes reais usados pelo código):
  `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_SECRET` (dev-only),
  `JWT_ISSUER`, `JWT_AUDIENCE`,
  `JWT_ACCESS_TTL_SECONDS` (default 900),
  `JWT_REFRESH_TTL_SECONDS` (default 604800),
  `ALLOW_SELF_SIGNUP`, `SERVICE_BOOTSTRAP_KEY`,
  `AUTH_LOCKOUT_WINDOW_SECONDS`, `AUTH_LOCKOUT_EMAIL_THRESHOLD`,
  `AUTH_LOCKOUT_IP_THRESHOLD`, `CORS_ORIGINS`, `GRPC_TLS_*`,
  `PLAYBOOKS_ENABLED` (defina `true` para resolver `metadata.playbook` a partir de hints LLM + templates; omitido/falso desliga o resolver),
  `PLAYBOOK_URL_ALLOWLIST` (CSV de hosts https permitidos em ações `open_url` dos playbooks; lista vazia bloqueia todas as URLs).

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
