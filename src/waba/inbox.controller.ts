import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { InboxService } from './inbox.service';
import { StorageService } from './storage.service';
import { SendTextDto } from './dto/waba.dto';

const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // limite de áudio da Cloud API

@Controller('inbox')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
  ) {}

  @Get('conversations')
  @SkipThrottle()
  async listConversations(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.inbox.listConversations(user);
  }

  @Get('conversations/:id/messages')
  @SkipThrottle()
  async listMessages(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') conversationId: string,
    @Query('before') before?: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.inbox.listMessages(user, conversationId, before);
  }

  @Post('conversations/:id/messages')
  async sendText(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') conversationId: string,
    @Body() dto: SendTextDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.inbox.sendText(user, conversationId, dto.text, dto.subject);
  }

  @Post('conversations/:id/audio')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_AUDIO_BYTES } }))
  async sendAudio(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') conversationId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!file?.buffer?.length) {
      throw new BadRequestException('Audio file is required (field "file")');
    }
    return this.inbox.sendAudio(user, conversationId, {
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
  }

  @Post('conversations/:id/call')
  async startCall(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') conversationId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.inbox.startCall(user, conversationId);
  }

  @Get('media/:assetId')
  @SkipThrottle()
  async streamMedia(
    @CurrentUser() user: TenantContext | undefined,
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    if (!user) throw new UnauthorizedException();
    const asset = await this.inbox.getMediaAsset(user, assetId);
    const stream = await this.storage.getObjectStream(asset.storageKey);
    res.setHeader('Content-Type', asset.contentType);
    if (asset.sizeBytes) res.setHeader('Content-Length', asset.sizeBytes);
    stream.pipe(res);
  }
}
