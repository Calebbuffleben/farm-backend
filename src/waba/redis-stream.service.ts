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

  /** Mesma conexão para filas leves (wa-session outbound). undefined sem REDIS_URL. */
  get redis(): RedisClientType | undefined {
    return this.client;
  }

  /**
   * SET NX com TTL — trava um reprocesso (abrir o chat não pode XADD a cada poll).
   * Sem Redis, devolve true: o publish em seguida já é no-op.
   */
  async claimOnce(key: string, ttlSec: number): Promise<boolean> {
    if (!this.client) return true;
    try {
      const set = await this.client.set(`farm:kick:${key}`, '1', {
        NX: true,
        EX: ttlSec,
      });
      return set === 'OK';
    } catch (err) {
      this.logger.error(`claimOnce failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** XADD farm:messages:ready — nunca lança (ingestão não pode falhar por Redis). */
  async publishMessageReady(fields: {
    messageId: string;
    tenantId: string;
    conversationId: string;
    sessionId: string;
    type: string;
  }): Promise<boolean> {
    if (!this.client) {
      this.logger.warn(`publish skipped (no REDIS_URL) message=${fields.messageId}`);
      return false;
    }
    try {
      await this.client.xAdd(MESSAGES_READY_STREAM, '*', {
        messageId: String(fields.messageId),
        tenantId: String(fields.tenantId),
        conversationId: String(fields.conversationId),
        sessionId: String(fields.sessionId),
        type: String(fields.type),
      });
      this.logger.log(`published ${MESSAGES_READY_STREAM} message=${fields.messageId}`);
      return true;
    } catch (err) {
      this.logger.error(
        `publishMessageReady failed for ${fields.messageId}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
