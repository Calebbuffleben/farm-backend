import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Client as MinioClient } from 'minio';
import type { Readable } from 'stream';

/**
 * Object storage das mídias (MinIO local / S3-compatível em prod).
 * A URL da Meta expira em minutos — a cópia aqui é a fonte permanente.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private client: MinioClient | undefined;
  private bucket = '';

  onModuleInit() {
    const endpoint = process.env.MEDIA_S3_ENDPOINT?.trim();
    if (!endpoint) {
      this.logger.warn(
        'MEDIA_S3_ENDPOINT not set — media storage disabled (webhook still ingests text)',
      );
      return;
    }
    const url = new URL(endpoint);
    this.bucket = process.env.MEDIA_S3_BUCKET?.trim() || 'farm-media';
    this.client = new MinioClient({
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      useSSL: url.protocol === 'https:',
      accessKey: process.env.MEDIA_S3_ACCESS_KEY ?? '',
      secretKey: process.env.MEDIA_S3_SECRET_KEY ?? '',
    });
    void this.ensureBucket();
  }

  get enabled(): boolean {
    return this.client !== undefined;
  }

  private async ensureBucket(): Promise<void> {
    if (!this.client) return;
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
        this.logger.log(`bucket created: ${this.bucket}`);
      }
    } catch (err) {
      this.logger.error(`ensureBucket failed: ${(err as Error).message}`);
    }
  }

  private requireClient(): MinioClient {
    if (!this.client) {
      throw new ServiceUnavailableException('Media storage is not configured');
    }
    return this.client;
  }

  async putObject(
    key: string,
    data: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.requireClient().putObject(this.bucket, key, data, data.length, {
      'Content-Type': contentType,
    });
  }

  async getObject(key: string): Promise<Buffer> {
    const stream = await this.getObjectStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async getObjectStream(key: string): Promise<Readable> {
    return this.requireClient().getObject(this.bucket, key);
  }

  async removeObject(key: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.removeObject(this.bucket, key);
    } catch (err) {
      this.logger.warn(`removeObject ${key}: ${(err as Error).message}`);
    }
  }
}
