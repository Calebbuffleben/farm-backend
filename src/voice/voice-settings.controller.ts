import {
  Body,
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../waba/waba-crypto';
import { e164 } from './twilio-media';
import {
  AssignVoiceNumberDto,
  CreateVoiceAccountDto,
  CreateVoiceNumberDto,
  PatchVoiceAccountDto,
} from './dto/voice.dto';
import { parseVoiceCredentials } from './voice.client';
import { farmPublicUrl } from '../channel/public-origin';

@Controller('voice')
export class VoiceSettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('accounts')
  @SkipThrottle()
  @AdminOnly()
  async listAccounts(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    const accounts = await this.prisma.channelAccount.findMany({
      where: { tenantId: user.tenantId, kind: 'VOICE' },
      include: {
        endpoints: {
          include: {
            assignedUser: {
              select: { id: true, name: true, email: true, phone: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map(({ credentialsEncrypted, ...rest }) => {
      let softphone = { apiKey: false, twimlApp: false };
      try {
        const creds = parseVoiceCredentials(credentialsEncrypted);
        softphone = {
          apiKey: Boolean(creds.apiKeySid && creds.apiKeySecret),
          twimlApp: Boolean(creds.twimlAppSid),
        };
      } catch {
        /* conta sem credencial válida */
      }
      return {
        ...rest,
        webhookPath: `/voice/webhook/${rest.id}`,
        recordingPath: `/voice/recording/${rest.id}`,
        publicOrigin: farmPublicUrl(),
        softphone,
      };
    });
  }

  @Post('accounts')
  @AdminOnly()
  async createAccount(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: CreateVoiceAccountDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const account = await this.prisma.channelAccount.create({
      data: {
        tenantId: user.tenantId,
        kind: 'VOICE',
        credentialsEncrypted: encryptSecret(
          JSON.stringify({
            accountSid: dto.accountSid.trim(),
            authToken: dto.authToken.trim(),
            ...(dto.apiKeySid?.trim()
              ? { apiKeySid: dto.apiKeySid.trim() }
              : {}),
            ...(dto.apiKeySecret?.trim()
              ? { apiKeySecret: dto.apiKeySecret.trim() }
              : {}),
            ...(dto.twimlAppSid?.trim()
              ? { twimlAppSid: dto.twimlAppSid.trim() }
              : {}),
          }),
        ),
        status: 'ACTIVE',
      },
    });
    return {
      id: account.id,
      status: account.status,
      webhookPath: `/voice/webhook/${account.id}`,
      recordingPath: `/voice/recording/${account.id}`,
    };
  }

  @Patch('accounts/:id')
  @AdminOnly()
  async patchAccount(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') accountId: string,
    @Body() dto: PatchVoiceAccountDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: accountId, tenantId: user.tenantId, kind: 'VOICE' },
    });
    if (!account) throw new NotFoundException('Voice account not found');
    const creds = parseVoiceCredentials(account.credentialsEncrypted);
    const sid = dto.apiKeySid?.trim();
    const secret = dto.apiKeySecret?.trim();
    if (Boolean(sid) !== Boolean(secret)) {
      throw new BadRequestException(
        'API Key SID e Secret precisam ir juntos',
      );
    }
    const next = {
      accountSid: creds.accountSid,
      authToken: creds.authToken,
      apiKeySid: sid || creds.apiKeySid,
      apiKeySecret: secret || creds.apiKeySecret,
      twimlAppSid: dto.twimlAppSid?.trim() || creds.twimlAppSid,
    };
    await this.prisma.channelAccount.update({
      where: { id: account.id },
      data: { credentialsEncrypted: encryptSecret(JSON.stringify(next)) },
    });
    return {
      id: account.id,
      status: account.status,
      webhookPath: `/voice/webhook/${account.id}`,
      recordingPath: `/voice/recording/${account.id}`,
      softphone: {
        apiKey: Boolean(next.apiKeySid && next.apiKeySecret),
        twimlApp: Boolean(next.twimlAppSid),
      },
    };
  }

  @Post('accounts/:id/numbers')
  @AdminOnly()
  async addNumber(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') accountId: string,
    @Body() dto: CreateVoiceNumberDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: accountId, tenantId: user.tenantId, kind: 'VOICE' },
    });
    if (!account) throw new NotFoundException('Voice account not found');
    const address = e164(dto.address);
    if (!address) throw new BadRequestException('E.164 inválido');

    if (dto.assignedUserId && dto.rtvPhone) {
      const phone = e164(dto.rtvPhone);
      if (phone) {
        await this.prisma.user.update({
          where: { id: dto.assignedUserId },
          data: { phone },
        });
      }
    }

    return this.prisma.channelEndpoint.create({
      data: {
        tenantId: user.tenantId,
        channelAccountId: account.id,
        address,
        displayAddress: address,
        assignedUserId: dto.assignedUserId ?? null,
      },
    });
  }

  @Patch('numbers/:id')
  @AdminOnly()
  async assignNumber(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') endpointId: string,
    @Body() dto: AssignVoiceNumberDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const endpoint = await this.prisma.channelEndpoint.findFirst({
      where: {
        id: endpointId,
        tenantId: user.tenantId,
        channelAccount: { kind: 'VOICE' },
      },
    });
    if (!endpoint) throw new NotFoundException('Voice number not found');
    if (dto.assignedUserId && dto.rtvPhone) {
      const phone = e164(dto.rtvPhone);
      if (phone) {
        await this.prisma.user.update({
          where: { id: dto.assignedUserId },
          data: { phone },
        });
      }
    }
    return this.prisma.channelEndpoint.update({
      where: { id: endpoint.id },
      data: { assignedUserId: dto.assignedUserId ?? null },
    });
  }
}
