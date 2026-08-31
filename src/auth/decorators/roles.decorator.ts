import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../auth.constants';
import type { TokenRole } from '../role.types';

/** Restrict a route to the given roles. Combine with the global JwtAuthGuard. */
export const Roles = (...roles: TokenRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Shorthand for routes reserved to tenant admins (OWNER or ADMIN).
 *
 * SERVICE tokens NEVER match — they represent backend workers, not
 * administrative actors, and are rejected by the HTTP guard regardless
 * of this decorator via the JwtAuthGuard's `access`-only policy.
 */
export const AdminOnly = () => Roles('OWNER', 'ADMIN');

/**
 * Live Floor / War Room / whisper. MANAGER cannot manage members,
 * invites, playbooks, or billing — those stay {@link AdminOnly}.
 */
export const ManagerAccess = () => Roles('OWNER', 'ADMIN', 'MANAGER');
