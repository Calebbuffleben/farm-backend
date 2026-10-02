import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { CreateDemoLeadDto } from './dto/leads.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Public()
  @Post('demo')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  createDemo(@Body() dto: CreateDemoLeadDto, @Req() req: Request) {
    return this.leads.createDemo(dto, readRequestMeta(req));
  }
}

function readRequestMeta(req: Request): { ip?: string; userAgent?: string } {
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    undefined;
  const userAgent = req.get?.('user-agent') ?? undefined;
  return { ip, userAgent };
}
