import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis-io.adapter';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

function parseCorsOrigins(): string[] | boolean {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[bootstrap] CORS_ORIGINS is empty in production — refusing all cross-origin requests.',
      );
      return [];
    }
    return true; // dev: allow all
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

dotenv.config({ path: resolve(process.cwd(), '.env') });
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: resolve(process.cwd(), 'env') });
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn', 'log'],
  });

  // TLS termina no proxy; sem isto req.protocol vira http e a Twilio
  // assina https — HMAC quebra se FARM_PUBLIC_URL não estiver setada.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false, // API; web app define o próprio CSP
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    const redisIoAdapter = new RedisIoAdapter(app);
    await redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);
    console.log(
      '[bootstrap] Socket.IO Redis adapter enabled | REDIS_URL=(set)',
    );
  } else {
    console.log(
      '[bootstrap] Socket.IO in-memory adapter (single replica or dev only) — set REDIS_URL for multi-replica broadcast',
    );
  }

  app.enableCors({
    origin: parseCorsOrigins(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Requested-With',
    ],
    exposedHeaders: ['X-Request-Id'],
  });

  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port, '0.0.0.0');

  // gRPC de ingestão de fatos (farm/intelligence → backend) entra na Fase 3,
  // no mesmo padrão do PublishFeedback do Meet (SERVICE JWT + x-tenant-id).
  console.log('[bootstrap] ready | PORT=%s', port);
}
bootstrap().catch((err) => {
  console.error('[bootstrap] fatal', err);
  process.exit(1);
});
