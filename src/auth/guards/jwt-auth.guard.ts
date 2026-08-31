import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../auth.constants';
import { AuthJwtService } from '../jwt.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import type { TenantContext } from '../../tenancy/tenant-context.types';

/**
 * Global HTTP guard.
 *
 * 1. Verifies `Authorization: Bearer <jwt>`.
 * 2. Rejects anything that is not an `access` token.
 * 3. Populates `request.user = TenantContext` — the authoritative source
 *    used by `@CurrentUser()` / `@CurrentTenantId()` decorators.
 * 4. Runs the rest of the request pipeline inside `TenantContextService.runHttp`
 *    so the Prisma middleware fail-closed safety net has a context to pull from.
 *
 * NOTE: Socket.IO, WS (`/egress-audio`) and gRPC do NOT use this guard —
 * they each validate their own credentials and pass context explicitly
 * (see `FeedbackGateway`, `FeedbackGrpcServer`).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: AuthJwtService,
    private readonly tenantContext: TenantContextService,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> | boolean {
    if (context.getType() !== 'http') {
      // Socket/gRPC contexts are authenticated at their own transport layer.
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: TenantContext;
    }>();

    // Fast path: `TenantContextMiddleware` runs earlier in the request
    // pipeline and already verified the token + populated `req.user`. Skip
    // the redundant verify to keep /auth/me, /feedback/metrics etc. cheap.
    if (req.user && req.user.userId && req.user.tenantId) {
      return true;
    }

    const token = extractBearerToken(req.headers);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let claims;
    try {
      claims = this.jwt.verify(token, 'access');
    } catch (err) {
      this.logger.warn(
        `[JwtAuthGuard] rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException('Invalid access token');
    }

    const ctx: TenantContext = Object.freeze({
      userId: claims.sub,
      tenantId: claims.tid!,
      membershipId: claims.mid ?? null,
      role: claims.role,
      jti: claims.jti,
    });
    req.user = ctx;

    // Chain the remainder of the HTTP request inside ALS. We return `true`
    // synchronously from here; to guarantee ALS envelops the controller and
    // downstream services we also mount `TenantContextMiddleware` which
    // runs earlier in the pipeline (see auth.module.ts). This guard is the
    // authorization gate; the middleware is the scope boundary.
    return true;
  }
}

export function extractBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') return null;
  const [scheme, token] = value.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}
