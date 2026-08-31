import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import {
  LoginDto,
  LogoutDto,
  RefreshDto,
  RegisterDto,
  ServiceTokenDto,
} from './dto/auth.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, readRequestMeta(req));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, readRequestMeta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(dto, readRequestMeta(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @SkipThrottle()
  async logout(
    @Body() dto: LogoutDto,
    @CurrentUser() user: TenantContext | undefined,
    @Req() req: Request,
  ): Promise<void> {
    if (!user) throw new UnauthorizedException();
    await this.authService.logout(
      { userId: user.userId, tenantId: user.tenantId },
      dto?.refreshToken,
      readRequestMeta(req),
    );
  }

  @Get('me')
  @SkipThrottle()
  me(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.authService.me(user.userId, user.tenantId);
  }

  /**
   * Mint a short-lived service token for a backend worker (e.g. python-service).
   *
   * Authenticated by a pre-shared `SERVICE_BOOTSTRAP_KEY` (NOT a JWT). The key
   * MUST be provisioned out-of-band (secret manager) and rotated periodically.
   * The response is **never cached**; clients should store the token only in
   * memory and re-mint before expiration.
   */
  @Public()
  @Post('service-token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async serviceToken(
    @Body() dto: ServiceTokenDto,
    @Req() req: Request,
  ): Promise<{
    token: string;
    tokenType: 'Bearer';
    tenantId: null;
    tenantSlug: null;
    expiresAt: number;
    label: string | null;
  }> {
    const expected = process.env.SERVICE_BOOTSTRAP_KEY || '';
    if (!expected) {
      this.logger.error(
        '/auth/service-token called but SERVICE_BOOTSTRAP_KEY is not configured — refusing.',
      );
      throw new ForbiddenException('Service token endpoint disabled');
    }

    const provided =
      (req.headers['x-service-bootstrap-key'] as string | undefined) ||
      extractBearer(req.headers['authorization'] as string | undefined) ||
      '';

    if (!provided || !constantTimeEquals(expected, provided)) {
      throw new ForbiddenException('Invalid bootstrap key');
    }

    return this.authService.mintServiceToken(dto, readRequestMeta(req));
  }
}

function extractBearer(header: string | undefined): string {
  if (!header) return '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return '';
  return token.trim();
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
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
