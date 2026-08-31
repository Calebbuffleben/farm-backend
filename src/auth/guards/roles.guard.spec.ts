import { ForbiddenException } from '@nestjs/common';
import { RolesGuard } from './roles.guard';
import type { TokenRole } from '../role.types';

function httpContext(role: TokenRole | undefined) {
  return {
    getType: () => 'http' as const,
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : undefined }),
    }),
  };
}

describe('RolesGuard access matrix', () => {
  const activate = (required: TokenRole[], role?: TokenRole) => {
    const guard = new RolesGuard({
      getAllAndOverride: () => required,
    } as never);
    return guard.canActivate(httpContext(role) as never);
  };

  it('lets MANAGER onto ManagerAccess routes', () => {
    expect(activate(['OWNER', 'ADMIN', 'MANAGER'], 'MANAGER')).toBe(true);
    expect(activate(['OWNER', 'ADMIN', 'MANAGER'], 'OWNER')).toBe(true);
  });

  it('rejects MANAGER on AdminOnly routes (members/invites/playbooks)', () => {
    expect(() => activate(['OWNER', 'ADMIN'], 'MANAGER')).toThrow(
      ForbiddenException,
    );
  });

  it('rejects MEMBER on monitor routes', () => {
    expect(() =>
      activate(['OWNER', 'ADMIN', 'MANAGER'], 'MEMBER'),
    ).toThrow(ForbiddenException);
  });
});
