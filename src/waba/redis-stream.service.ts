import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';

export const MESSAGES_READY_STREAM = 'farm:messages:ready';

/**
 * Publica mensagens prontas para análise (texto ingerido ou mídia baixada)
 * no stream consumido pelo worker Python (farm/intelligence).
 */
@Injectable()
export class RedisStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisStreamService.name);
  private client: RedisClientType | undefined;

  async onModuleInit() {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
      this.logger.warn(
        'REDIS_URL not set — farm:messages:ready publishing disabled',
      );
      return;
    }
    this.client = createClient({ url });
    this.client.on('error', (err) =>
      this.logger.error(`redis error: ${err.message}`),
    );
    await this.client.connect();
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => undefined);
  }

  /** XADD farm:messages:ready — nunca lança (ingestão não pode falhar por Redis). */
  async publishMessageReady(fields: {
    messageId: string;
    tenantId: string;
    conversationId: string;
    sessionId: string;
    type: string;
  }): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.xAdd(MESSAGES_READY_STREAM, '*', fields);
    } catch (err) {
      this.logger.error(
        `publishMessageReady failed for ${fields.messageId}: ${(err as Error).message}`,
      );
    }
  }
}
