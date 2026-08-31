import { canAccessManagerFloor, isAdmin, isMembershipRole } from './role.types';

describe('manager access roles', () => {
  it('allows OWNER, ADMIN and MANAGER on the live floor', () => {
    expect(canAccessManagerFloor('OWNER')).toBe(true);
    expect(canAccessManagerFloor('ADMIN')).toBe(true);
    expect(canAccessManagerFloor('MANAGER')).toBe(true);
    expect(canAccessManagerFloor('MEMBER')).toBe(false);
    expect(canAccessManagerFloor('SERVICE')).toBe(false);
  });

  it('keeps MANAGER out of AdminOnly privileges', () => {
    expect(isAdmin('OWNER')).toBe(true);
    expect(isAdmin('ADMIN')).toBe(true);
    expect(isAdmin('MANAGER')).toBe(false);
    expect(isAdmin('MEMBER')).toBe(false);
  });

  it('accepts MANAGER as a membership role', () => {
    expect(isMembershipRole('MANAGER')).toBe(true);
    expect(isMembershipRole('GUEST')).toBe(false);
  });
});
