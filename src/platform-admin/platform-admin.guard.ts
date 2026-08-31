import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

const HEADER = 'x-platform-admin-token';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.PLATFORM_ADMIN_API_TOKEN?.trim();
    if (!expected) {
      throw new UnauthorizedException('PLATFORM_ADMIN_API_TOKEN is not configured');
    }
    const req = context.switchToHttp().getRequest<Request>();
    const token = req.get(HEADER) || readBearer(req.get('authorization'));
    if (!token || token !== expected) {
      throw new UnauthorizedException('Invalid platform admin token');
    }
    return true;
  }
}

function readBearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}
