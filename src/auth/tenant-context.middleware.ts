import {
  ForbiddenException,
  Injectable,
  Logger,
  NestMiddleware,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AuthJwtService } from './jwt.service';
import {
  assertTenantMatch,
  TenantContextService,
} from '../tenancy/tenant-context.service';
import {
  TenantMismatchError,
  type TenantContext,
} from '../tenancy/tenant-context.types';
import { extractBearerToken } from './guards/jwt-auth.guard';

/**
 * Early HTTP middleware that resolves the authenticated tenant context and
 * wraps the rest of the request in `TenantContextService.runHttp`.
 *
 * - Never throws on invalid/missing tokens; authorization enforcement lives
 *   in `JwtAuthGuard`. This lets `/health`, `/auth/login`, `/auth/register`,
 *   `/auth/refresh` reach their `@Public()` handlers without a token.
 * - When a valid access token is present, populates `req.user` AND binds
 *   the ALS context so the Prisma tenancy middleware's fail-closed safety
 *   net has a value to fall back to.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(
    private readonly jwt: AuthJwtService,
    private readonly tenantContext: TenantContextService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const token = extractBearerToken(req.headers as Record<string, any>);
    if (!token) {
      return next();
    }

    let ctx: TenantContext;
    try {
      const claims = this.jwt.verify(token, 'access');
      ctx = Object.freeze({
        userId: claims.sub,
        tenantId: claims.tid!,
        membershipId: claims.mid ?? null,
        role: claims.role,
        jti: claims.jti,
      });
    } catch (err) {
      // Let JwtAuthGuard emit the 401 on non-public routes. We purposely do
      // NOT leak verification details in logs (potential token in header).
      this.logger.debug(
        `[TenantContextMiddleware] token rejected: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return next();
    }

    // Redundant tenant validation: if the client also sends `x-tenant-id`
    // (common in socket/grpc parity clients), it MUST match the token's
    // `tid`. This mirrors the socket/grpc transports and stops tools that
    // naïvely send a tenant header from acting on the wrong tenant.
    const headerTenant = firstHeader(req.headers['x-tenant-id']);
    try {
      assertTenantMatch(ctx.tenantId, headerTenant);
    } catch (err) {
      if (err instanceof TenantMismatchError) {
        this.logger.warn(
          `[TenantContextMiddleware] HTTP tenant mismatch: token=${err.tokenTenantId} header=${err.claimedTenantId}`,
        );
        throw new ForbiddenException('Tenant mismatch');
      }
      throw err;
    }

    (req as Request & { user?: TenantContext }).user = ctx;
    this.tenantContext.runHttp(ctx, () => next());
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  const s = Array.isArray(value) ? value[0] : value;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}
