import {
  BadRequestException,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { PrismaService } from '../prisma/prisma.service';
import { CoreIngestService } from '../channel/core-ingest.service';
import { OpsService } from '../ops/ops.service';
import { twilioWebhookUrl, farmPublicOrigin, verifyTwilioSignature } from './twilio-signature';
import { e164 } from './twilio-media';
import { parseVoiceCredentials, VoiceClient } from './voice.client';
import { dialTwiml, hangupTwiml } from './voice.twiml';
import {
  mintVoiceAccessToken,
  parseVoiceClientFrom,
  recordingCallbackUrl,
  userIdFromVoiceIdentity,
  voiceClientIdentity,
} from './voice-token';

type Form = Record<string, string | string[] | undefined>;

function formString(body: Form, key: string): string {
  const v = body[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * Webhooks Twilio Voice. TwiML em &lt;80ms (sem download). Message AUDIO só
 * no recording completed → CoreIngest.
 */
@Controller('voice')
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreIngestService,
    private readonly voice: VoiceClient,
    private readonly ops: OpsService,
  ) {}

  @Public()
  @SkipThrottle()
  @Post('webhook/:accountId')
  @Header('Content-Type', 'text/xml; charset=utf-8')
  async twiml(
    @Param('accountId') accountId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const loaded = await this.loadVoiceAccount(accountId);
    if (!loaded) {
      res.status(HttpStatus.FORBIDDEN);
      return hangupTwiml('Conta de voz inválida.');
    }
    const { account, creds } = loaded;
    const params = (req.body ?? {}) as Form;
    if (
      !verifyTwilioSignature(
        creds.authToken,
        req.get('x-twilio-signature'),
        twilioWebhookUrl(req),
        params,
      )
    ) {
      res.status(HttpStatus.FORBIDDEN);
      return hangupTwiml('Assinatura inválida.');
    }

    const direction = formString(params, 'Direction');
    const fromRaw = formString(params, 'From');
    const from = e164(fromRaw);
    const to = e164(formString(params, 'To'));
    const origin = farmPublicOrigin(req);
    const clientIdentity = parseVoiceClientFrom(fromRaw);

    if (clientIdentity) {
      const userId = userIdFromVoiceIdentity(clientIdentity);
      const peer = e164(formString(params, 'peer'));
      const endpoint = userId
        ? await this.prisma.channelEndpoint.findFirst({
            where: {
              tenantId: account.tenantId,
              channelAccountId: account.id,
              assignedUserId: userId,
            },
            orderBy: { createdAt: 'asc' },
          })
        : null;
      const ourNumber = e164(endpoint?.address);
      if (!endpoint || !ourNumber || !peer) {
        return hangupTwiml(
          'Não foi possível completar a ligação. Tente novamente mais tarde.',
        );
      }
      return dialTwiml({
        callerId: ourNumber,
        rtvE164: peer,
        recordingCallback: recordingCallbackUrl(
          origin,
          account.id,
          ourNumber,
          peer,
          'OUT',
        ),
      });
    }

    const ourNumber = direction.startsWith('outbound') ? from : to;
    if (!ourNumber) {
      return hangupTwiml('Número de destino inválido.');
    }

    const endpoint = await this.prisma.channelEndpoint.findFirst({
      where: {
        tenantId: account.tenantId,
        channelAccountId: account.id,
        address: ourNumber,
      },
      include: { assignedUser: { select: { id: true, phone: true } } },
    });
    const rtvE164 = e164(endpoint?.assignedUser?.phone ?? undefined);
    const softphoneId = endpoint?.assignedUser?.id
      ? voiceClientIdentity(endpoint.assignedUser.id)
      : null;
    if (!endpoint || (!rtvE164 && !softphoneId)) {
      return hangupTwiml(
        'Não foi possível completar a ligação. Tente novamente mais tarde.',
      );
    }

    const peer = direction.startsWith('outbound') ? to : from;
    if (!peer) {
      return hangupTwiml('Número de destino inválido.');
    }
    return dialTwiml({
      callerId: ourNumber,
      rtvE164,
      clientIdentity: softphoneId,
      recordingCallback: recordingCallbackUrl(
        origin,
        account.id,
        ourNumber,
        peer,
        direction.startsWith('outbound') ? 'OUT' : 'IN',
      ),
    });
  }

  @SkipThrottle()
  @Post('token')
  async token(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    const endpoint = await this.prisma.channelEndpoint.findFirst({
      where: {
        tenantId: user.tenantId,
        assignedUserId: user.userId,
        channelAccount: { kind: 'VOICE', status: { not: 'DISABLED' } },
      },
      orderBy: { createdAt: 'asc' },
      include: { channelAccount: true },
    });
    if (!endpoint) {
      throw new BadRequestException(
        'Nenhum número de voz atribuído a você',
      );
    }
    try {
      const creds = parseVoiceCredentials(
        endpoint.channelAccount.credentialsEncrypted,
      );
      return mintVoiceAccessToken(creds, voiceClientIdentity(user.userId));
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Falha ao emitir token de voz',
      );
    }
  }

  @Public()
  @SkipThrottle()
  @Post('recording/:accountId')
  @HttpCode(HttpStatus.OK)
  async receiveRecording(
    @Param('accountId') accountId: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.processRecording(accountId, req);
    return { ok: true };
  }

  private async processRecording(accountId: string, req: Request): Promise<void> {
    const loaded = await this.loadVoiceAccount(accountId);
    if (!loaded) {
      this.logger.warn(`recording for unknown account ${accountId}`);
      return;
    }
    const { account, creds } = loaded;
    const params = (req.body ?? {}) as Form;
    if (
      !verifyTwilioSignature(
        creds.authToken,
        req.get('x-twilio-signature'),
        twilioWebhookUrl(req),
        params,
      )
    ) {
      this.logger.warn(`invalid recording signature account=${accountId}`);
      return;
    }

    const status = formString(params, 'RecordingStatus');
    if (status && status !== 'completed') return;

    const recordingSid = formString(params, 'RecordingSid');
    const recordingUrl = formString(params, 'RecordingUrl');
    const callSid = formString(params, 'CallSid');
    if (!recordingSid || !callSid) return;

    this.ops.record({
      service: 'farm-backend',
      stage: 'voice.recording.received',
      message: recordingSid,
      tenantId: account.tenantId,
      metadata: { callSid },
    });

    const q = req.query as Record<string, string | string[] | undefined>;
    let peerAddress = e164(formString(q, 'peer'));
    let ourNumber = e164(formString(q, 'our'));
    let outbound = formString(q, 'dir') === 'OUT';
    if (!peerAddress || !ourNumber) {
      const call = await this.voice.getCall(creds, callSid);
      const fromClient = parseVoiceClientFrom(call.from);
      if (fromClient) {
        const userId = userIdFromVoiceIdentity(fromClient);
        const owned = userId
          ? await this.prisma.channelEndpoint.findFirst({
              where: {
                tenantId: account.tenantId,
                channelAccountId: account.id,
                assignedUserId: userId,
              },
              orderBy: { createdAt: 'asc' },
            })
          : null;
        outbound = true;
        ourNumber = e164(owned?.address);
        peerAddress = e164(call.to);
      } else {
        outbound = call.direction.startsWith('outbound');
        peerAddress = e164(outbound ? call.to : call.from);
        ourNumber = e164(outbound ? call.from : call.to);
      }
    }
    if (!peerAddress || !ourNumber) {
      this.logger.warn(`recording ${recordingSid} missing From/To`);
      return;
    }

    const endpoint = await this.prisma.channelEndpoint.findFirst({
      where: {
        tenantId: account.tenantId,
        channelAccountId: account.id,
        address: ourNumber,
      },
    });
    if (!endpoint) {
      this.logger.warn(`recording ${recordingSid} no endpoint for ${ourNumber}`);
      return;
    }

    const durationSec = Number(formString(params, 'RecordingDuration') || '0');
    await this.core.ingest({
      tenantId: account.tenantId,
      endpointId: endpoint.id,
      peerAddress,
      externalId: `twilio:${recordingSid}`,
      direction: outbound ? 'OUT' : 'IN',
      type: 'AUDIO',
      sentAt: new Date(),
      mediaRef: {
        vendor: 'twilio',
        recordingSid,
        recordingUrl: recordingUrl || null,
        callSid,
        durationSec: Number.isFinite(durationSec) ? durationSec : 0,
        accountSid: creds.accountSid,
        attempts: 0,
      } satisfies Prisma.JsonObject,
    });
  }

  private async loadVoiceAccount(accountId: string) {
    const account = await this.prisma.channelAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.kind !== 'VOICE' || account.status === 'DISABLED') {
      return null;
    }
    try {
      return { account, creds: parseVoiceCredentials(account.credentialsEncrypted) };
    } catch {
      this.logger.warn(`voice account ${accountId} has invalid credentials`);
      return null;
    }
  }
}
