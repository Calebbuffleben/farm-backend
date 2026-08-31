import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

const HEADER = 'x-internal-token';

/**
 * Autentica o worker interno (farm/intelligence) por shared secret.
 * SERVICE JWTs são rejeitados no HTTP por política do JwtAuthGuard — este
 * guard segue o mesmo padrão do PlatformAdminGuard (secret de ambiente).
 */
@Injectable()
export class InternalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_TOKEN?.trim();
    if (!expected) {
      throw new UnauthorizedException('INTERNAL_API_TOKEN is not configured');
    }
    const req = context.switchToHttp().getRequest<Request>();
    const token = req.get(HEADER);
    if (!token || token !== expected) {
      throw new UnauthorizedException('Invalid internal token');
    }
    return true;
  }
}
