import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { TenantContext } from '../../tenancy/tenant-context.types';

/** Read the authenticated user/tenant context from `request.user`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: TenantContext }>();
    return req?.user;
  },
);

export const CurrentTenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: TenantContext }>();
    return req?.user?.tenantId;
  },
);
