import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import { Prisma } from '@prisma/client';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';

const FIXTURE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

function fixturesRoot(): string {
  return (
    process.env.FARM_FIXTURES_DIR?.trim() ||
    join(process.cwd(), '..', 'fixtures')
  );
}

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  /** Fixture local (dev). MediaWorker lê o arquivo em disco; isto é só para inspeção. */
  @Public()
  @Get('dev/fixtures/:name')
  async fixture(@Param('name') name: string, @Res() res: Response) {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    const safe = basename(name);
    if (!safe || safe !== name.replace(/[/\\]/g, '')) {
      throw new NotFoundException();
    }
    try {
      const data = await readFile(join(fixturesRoot(), safe));
      const ext = safe.split('.').pop()?.toLowerCase() ?? '';
      res.setHeader(
        'Content-Type',
        FIXTURE_MIME[ext] ?? 'application/octet-stream',
      );
      res.send(data);
    } catch {
      throw new NotFoundException();
    }
  }

  /** Re-enfileira mídia FAILED (ex.: fixture ausente antes do deploy). Só dev. */
  @Public()
  @Post('dev/messages/:id/retry-media')
  async retryMedia(@Param('id') id: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    const message = await this.prisma.message.findUnique({ where: { id } });
    if (!message || message.mediaStatus !== 'FAILED') {
      throw new NotFoundException('Message not found or media not FAILED');
    }
    const ref = (message.mediaRef ?? {}) as Record<string, unknown>;
    await this.prisma.message.update({
      where: { id },
      data: {
        mediaStatus: 'PENDING_MEDIA',
        mediaRef: {
          ...ref,
          attempts: 0,
          lastError: null,
        } as Prisma.JsonObject,
      },
    });
    return { ok: true, messageId: id };
  }
}
