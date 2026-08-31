import {
  Catch,
  Controller,
  ArgumentsHost,
  ExceptionFilter,
  HttpException,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  UploadedFiles,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CoreIngestService } from '../channel/core-ingest.service';
import { OpsService } from '../ops/ops.service';
import { StorageService } from '../waba/storage.service';
import { extractEmail } from '../channel/peer-address';
import { parseEmailCredentials } from './email.client';
import { verifyMailgunSignature } from './mailgun-signature';
import {
  collectAttachments,
  composeEmailBody,
  emailExternalId,
  parseMailgunHeaders,
  recipientAddresses,
  shouldDiscardInbound,
  takeAttachmentBudget,
  type InboundAttachment,
} from './mailgun-parse';

function isMailgunTooBig(exception: unknown): boolean {
  if (!exception || typeof exception !== 'object') return false;
  const e = exception as { name?: string; code?: string; getStatus?: () => number };
  if (e.name === 'MulterError') return true;
  if (
    e.code === 'LIMIT_FILE_SIZE' ||
    e.code === 'LIMIT_FILE_COUNT' ||
    e.code === 'LIMIT_UNEXPECTED_FILE'
  ) {
    return true;
  }
  return typeof e.getStatus === 'function' && e.getStatus() === 413;
}

/** Anexo grande demais: 200 para o Mailgun parar de retrucar. */
@Catch()
class EmailInboundAckFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<{
      headersSent: boolean;
      status: (n: number) => { json: (b: unknown) => void };
    }>();
    if (res.headersSent) return;
    if (isMailgunTooBig(exception)) {
      res.status(200).json({ ok: true });
      return;
    }
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    res.status(500).json({ ok: false });
  }
}

/**
 * Inbound Mailgun. 200 imediato (sem download/LLM). Message TEXT + DOCUMENT
 * por anexo (MediaWorker). Identidade = (endpoint, peer email), nunca assunto.
 */
@Controller('email')
export class EmailController {
  private readonly logger = new Logger(EmailController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreIngestService,
    private readonly ops: OpsService,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @SkipThrottle()
  @Post('webhook/:accountId')
  @HttpCode(HttpStatus.OK)
  @UseFilters(EmailInboundAckFilter)
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: { files: 10, fileSize: 15 * 1024 * 1024 },
    }),
  )
  receive(
    @Param('accountId') accountId: string,
    @Req() req: Request,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): { ok: true } {
    const fields: Record<string, string> = {};
    const body = (req.body ?? {}) as Record<string, string | string[] | undefined>;
    for (const [k, v] of Object.entries(body)) {
      fields[k] = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
    }
    const copied = (files ?? []).map((f) => ({
      fieldname: f.fieldname,
      originalname: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
      buffer: Buffer.from(f.buffer),
    }));
    void this.process(accountId, fields, copied).catch((err: Error) =>
      this.logger.error(`email ingest failed: ${err.message}`),
    );
    return { ok: true };
  }

  private async process(
    accountId: string,
    fields: Record<string, string>,
    files: {
      fieldname: string;
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    }[],
  ): Promise<void> {
    const account = await this.prisma.channelAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.kind !== 'EMAIL' || account.status === 'DISABLED') {
      this.logger.warn(`email webhook unknown account ${accountId}`);
      return;
    }

    let creds;
    try {
      creds = parseEmailCredentials(account.credentialsEncrypted);
    } catch {
      this.logger.warn(`email account ${accountId} has invalid credentials`);
      return;
    }

    if (
      !verifyMailgunSignature(
        creds.signingKey,
        fields.timestamp,
        fields.token,
        fields.signature,
      )
    ) {
      this.logger.warn(`invalid mailgun signature account=${accountId}`);
      return;
    }

    const headers = parseMailgunHeaders(fields['message-headers']);
    const senderRaw = fields.sender || fields.from || '';
    if (shouldDiscardInbound({ sender: senderRaw, headers })) {
      this.ops.record({
        service: 'farm-backend',
        stage: 'email.inbound.discarded',
        message: extractEmail(senderRaw) ?? senderRaw,
        tenantId: account.tenantId,
      });
      return;
    }

    const peerAddress = extractEmail(senderRaw);
    if (!peerAddress) {
      this.logger.warn(`email inbound missing sender account=${accountId}`);
      return;
    }

    const recipients = recipientAddresses(
      fields.recipient || fields.to || '',
    );
    const endpoint = await this.prisma.channelEndpoint.findFirst({
      where: {
        tenantId: account.tenantId,
        channelAccountId: account.id,
        address: { in: recipients.length ? recipients : [''] },
      },
    });
    if (!endpoint) {
      this.logger.warn(
        `email inbound no endpoint for ${recipients.join(',')} account=${accountId}`,
      );
      return;
    }

    const subject = (fields.subject ?? '').trim();
    const body = composeEmailBody(
      subject,
      fields['body-plain'] ?? fields['stripped-text'] ?? '',
      fields['body-html'] ?? fields['stripped-html'] ?? '',
    );
    const timestamp = fields.timestamp ?? '';
    const token = fields.token ?? '';
    const sentAt = timestamp
      ? new Date(Number(timestamp) * 1000)
      : new Date();
    const sentAtSafe = Number.isNaN(sentAt.getTime()) ? new Date() : sentAt;

    this.ops.record({
      service: 'farm-backend',
      stage: 'email.inbound.received',
      message: fields['Message-Id'] || fields['message-id'] || token,
      tenantId: account.tenantId,
      metadata: { endpointId: endpoint.id },
    });

    if (body) {
      await this.core.ingest({
        tenantId: account.tenantId,
        endpointId: endpoint.id,
        peerAddress,
        externalId: emailExternalId(
          fields['Message-Id'] || fields['message-id'],
          timestamp,
          token,
        ),
        direction: 'IN',
        type: 'TEXT',
        body,
        sentAt: sentAtSafe,
        subject,
      });
    }

    const { kept, dropped } = takeAttachmentBudget(
      collectAttachments(fields, files),
    );
    if (dropped > 0) {
      this.ops.record({
        service: 'farm-backend',
        stage: 'email.attachment.dropped',
        message: `${dropped} anexos acima do teto 10/15MB`,
        tenantId: account.tenantId,
        severity: 'warning',
      });
    }

    for (const att of kept) {
      await this.ingestAttachment({
        tenantId: account.tenantId,
        endpointId: endpoint.id,
        peerAddress,
        subject,
        sentAt: sentAtSafe,
        att,
        messageId: fields['Message-Id'] || fields['message-id'] || token,
      });
    }
  }

  private async ingestAttachment(input: {
    tenantId: string;
    endpointId: string;
    peerAddress: string;
    subject: string;
    sentAt: Date;
    att: InboundAttachment;
    messageId: string;
  }): Promise<void> {
    const mediaRef: Prisma.JsonObject = {
      vendor: 'mailgun',
      filename: input.att.filename,
      mimeType: input.att.mimeType,
      attempts: 0,
    };
    if (input.att.url) {
      mediaRef.url = input.att.url;
    } else if (input.att.buffer && this.storage.enabled) {
      const stagingKey = `${input.tenantId}/mailgun-inbox/${randomUUID()}`;
      await this.storage.putObject(
        stagingKey,
        input.att.buffer,
        input.att.mimeType,
      );
      mediaRef.stagingKey = stagingKey;
    } else if (input.att.buffer && !this.storage.enabled) {
      this.logger.warn('email attachment skipped — media storage not configured');
      return;
    } else {
      return;
    }

    const suffix = input.att.url || (mediaRef.stagingKey as string);
    await this.core.ingest({
      tenantId: input.tenantId,
      endpointId: input.endpointId,
      peerAddress: input.peerAddress,
      externalId: `email:${input.messageId.replace(/^<|>$/g, '')}:att:${suffix.slice(-48)}`,
      direction: 'IN',
      type: 'DOCUMENT',
      body: input.subject ? `Assunto: ${input.subject}` : input.att.filename,
      sentAt: input.sentAt,
      subject: input.subject,
      mediaRef,
    });
  }
}
