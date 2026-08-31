import type { MembershipRole } from '@prisma/client';

/**
 * Superset of {@link MembershipRole} used inside JWT claims and propagated
 * through {@link TenantContext}. Service tokens carry `SERVICE` which is
 * intentionally NOT persisted in the `MembershipRole` DB enum — a service
 * token represents a trusted backend worker, not a human user.
 */
export type TokenRole = MembershipRole | 'SERVICE';

export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as const;
export const ADMIN_ROLES: readonly TokenRole[] = ['OWNER', 'ADMIN'];
export const MANAGER_ACCESS_ROLES: readonly TokenRole[] = [
  'OWNER',
  'ADMIN',
  'MANAGER',
];

/**
 * Returns `true` when the token role has administrative privileges over
 * the tenant (can invite, remove members, upgrade billing).
 *
 * SERVICE is deliberately excluded — service tokens are cross-cutting
 * ingestion credentials, not administrative actors.
 */
export function isAdmin(role: TokenRole | undefined | null): boolean {
  if (!role) return false;
  return role === 'OWNER' || role === 'ADMIN';
}

export function isMembershipRole(value: unknown): value is MembershipRole {
  return (
    value === 'OWNER' ||
    value === 'ADMIN' ||
    value === 'MANAGER' ||
    value === 'MEMBER'
  );
}

/** Live Floor / War Room / whisper — OWNER, ADMIN, and MANAGER. */
export function canAccessManagerFloor(
  role: TokenRole | undefined | null,
): boolean {
  if (!role) return false;
  return role === 'OWNER' || role === 'ADMIN' || role === 'MANAGER';
}
