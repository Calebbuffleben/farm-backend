import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import {
  MembershipRole,
  Plan,
  SubscriptionStatus,
  TenantStatus,
  type Tenant,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuthJwtService } from './jwt.service';
import {
  ARGON2_OPTIONS,
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_REFRESH_TTL_SECONDS,
  DEFAULT_SERVICE_TTL_SECONDS,
} from './auth.constants';
import { planToMaxUsers } from '../billing/plan-limits';
import { denyIfNotEntitled, entitlementEnforced, isEntitled } from '../billing/entitlement';
import type { TokenRole } from './role.types';
import {
  LoginDto,
  RefreshDto,
  RegisterDto,
  ServiceTokenDto,
} from './dto/auth.dto';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch ms
  refreshExpiresAt: number; // epoch ms
  tokenType: 'Bearer';
}

export interface AuthSession extends AuthTokens {
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  membership: {
    id: string;
    tenantId: string;
    role: MembershipRole;
  };
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
}

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

interface IssueTokenSubject {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: MembershipRole;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly allowSelfSignup: boolean;
  private readonly lockoutWindowSeconds: number;
  private readonly lockoutThreshold: number;
  private readonly lockoutIpThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly jwt: AuthJwtService,
  ) {
    this.accessTtlSeconds = numFromEnv(
      'JWT_ACCESS_TTL_SECONDS',
      DEFAULT_ACCESS_TTL_SECONDS,
    );
    this.refreshTtlSeconds = numFromEnv(
      'JWT_REFRESH_TTL_SECONDS',
      DEFAULT_REFRESH_TTL_SECONDS,
    );
    this.allowSelfSignup =
      String(process.env.ALLOW_SELF_SIGNUP || '').toLowerCase() === 'true';
    // Login lockout (complements per-route throttle). Enforces an upper
    // bound on failed attempts over a sliding window, scoped by email
    // (tenantId + email) AND by IP. Reset on successful login.
    this.lockoutWindowSeconds = numFromEnv('AUTH_LOCKOUT_WINDOW_SECONDS', 300);
    this.lockoutThreshold = numFromEnv('AUTH_LOCKOUT_EMAIL_THRESHOLD', 5);
    this.lockoutIpThreshold = numFromEnv('AUTH_LOCKOUT_IP_THRESHOLD', 20);
  }

  /**
   * Brand-new account flow:
   *
   *   1. Creates a global User (email must be unused across the platform).
   *   2. Creates the Tenant (slug must be unique).
   *   3. Creates the OWNER Membership.
   *   4. Creates a FREE Subscription with `maxUsers = 3`.
   *   5. Issues access+refresh tokens scoped to the new membership.
   *
   * To add an existing user to another tenant, use the invitation flow
   * instead (`POST /invites` + `POST /invites/accept`).
   */
  async register(dto: RegisterDto, meta: RequestMeta): Promise<AuthSession> {
    if (!this.allowSelfSignup) {
      throw new UnauthorizedException(
        'Self-signup is disabled (set ALLOW_SELF_SIGNUP=true)',
      );
    }
    const email = dto.email.trim().toLowerCase();
    const tenantSlug = (dto.tenantSlug || 'default').trim().toLowerCase();

    return this.tenantCtx.runWithTenantBypass(async () => {
      const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

      const existingUser = await this.prisma.user.findUnique({
        where: { email },
      });
      if (existingUser) {
        throw new ConflictException(
          'Email already registered — log in and ask an admin to invite you to a new tenant.',
        );
      }

      const existingTenant = await this.prisma.tenant.findUnique({
        where: { slug: tenantSlug },
      });
      if (existingTenant) {
        throw new ConflictException('Tenant slug already taken');
      }

      // Create the user first so we can wire FKs without null juggling.
      const user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          name: dto.name?.trim() || null,
          isActive: true,
        },
      });

      const tenant = await this.prisma.tenant.create({
        data: {
          slug: tenantSlug,
          name: dto.tenantName?.trim() || tenantSlug,
          status: TenantStatus.ACTIVE,
        },
      });

      const membership = await this.prisma.membership.create({
        data: {
          userId: user.id,
          tenantId: tenant.id,
          role: MembershipRole.OWNER,
        },
      });

      // Bootstrap subscription. FREE plan => 3 seats. The creator (OWNER)
      // already takes one of those seats.
      await this.prisma.subscription.create({
        data: {
          tenantId: tenant.id,
          plan: Plan.FREE,
          maxUsers: planToMaxUsers(Plan.FREE),
          status: SubscriptionStatus.ACTIVE,
        },
      });

      await this.writeAuditLog(tenant.id, user.id, 'auth.register', meta, {
        membershipId: membership.id,
        role: membership.role,
      });

      const tokens = await this.issueTokens(
        {
          userId: user.id,
          tenantId: tenant.id,
          membershipId: membership.id,
          role: membership.role,
        },
        meta,
      );

      return this.toSession(
        tokens,
        { id: user.id, email: user.email, name: user.name },
        { id: membership.id, tenantId: tenant.id, role: membership.role },
        { id: tenant.id, slug: tenant.slug, name: tenant.name },
      );
    });
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<AuthSession> {
    const email = dto.email.trim().toLowerCase();
    const requestedSlug = dto.tenantSlug?.trim().toLowerCase() || null;

    return this.tenantCtx.runWithTenantBypass(async () => {
      const tenantFromSlug = requestedSlug
        ? await this.prisma.tenant.findUnique({ where: { slug: requestedSlug } })
        : null;
      if (requestedSlug && (!tenantFromSlug || tenantFromSlug.status !== TenantStatus.ACTIVE)) {
        throw new UnauthorizedException('Invalid credentials');
      }

      // Lockout gate (per-email in this tenant AND per-IP). Without slug we
      // only know the tenant after password verification.
      if (tenantFromSlug) {
        const locked = await this.isLoginLocked(tenantFromSlug.id, email, meta.ip);
        if (locked) {
          await this.writeAuditLog(tenantFromSlug.id, null, 'auth.login.lockout', meta, {
            email,
            reason: 'threshold_exceeded',
          });
          throw new UnauthorizedException(
            'Too many failed attempts. Try again later.',
          );
        }
      }

      const user = await this.prisma.user.findUnique({ where: { email } });
      if (!user || !user.isActive || !user.passwordHash) {
        await argon2.hash('decoy-password-for-timing', ARGON2_OPTIONS).catch(
          () => undefined,
        );
        if (tenantFromSlug) {
          await this.writeAuditLog(tenantFromSlug.id, null, 'auth.login.fail', meta, {
            email,
          });
        }
        throw new UnauthorizedException('Invalid credentials');
      }

      const ok = await argon2.verify(user.passwordHash, dto.password);
      if (!ok) {
        if (tenantFromSlug) {
          await this.writeAuditLog(tenantFromSlug.id, user.id, 'auth.login.fail', meta, {
            email,
          });
        }
        throw new UnauthorizedException('Invalid credentials');
      }

      const tenant = tenantFromSlug ?? (await this.pickSoleActiveTenant(user.id));
      if (!tenant) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const membership = await this.prisma.membership.findUnique({
        where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
      });
      if (!membership) {
        await this.writeAuditLog(
          tenant.id,
          user.id,
          'auth.login.no_membership',
          meta,
          { email },
        );
        throw new UnauthorizedException(
          'You do not have access to this tenant. Ask an admin to invite you.',
        );
      }

      if (!tenantFromSlug) {
        const locked = await this.isLoginLocked(tenant.id, email, meta.ip);
        if (locked) {
          throw new UnauthorizedException(
            'Too many failed attempts. Try again later.',
          );
        }
      }

      const subscription = await this.prisma.subscription.findUnique({
        where: { tenantId: tenant.id },
      });
      denyIfNotEntitled(subscription?.plan, subscription?.status);

      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      await this.resetLoginFailures(tenant.id, email);
      await this.writeAuditLog(tenant.id, user.id, 'auth.login.ok', meta, {
        membershipId: membership.id,
        role: membership.role,
      });

      const tokens = await this.issueTokens(
        {
          userId: user.id,
          tenantId: tenant.id,
          membershipId: membership.id,
          role: membership.role,
        },
        meta,
      );

      return this.toSession(
        tokens,
        { id: user.id, email: user.email, name: user.name },
        { id: membership.id, tenantId: tenant.id, role: membership.role },
        { id: tenant.id, slug: tenant.slug, name: tenant.name },
      );
    });
  }

  /**
   * Farm tenants have real slugs (no Meet leftover "default").
   * One active membership → that tenant. Two+ → caller must send tenantSlug.
   */
  private async pickSoleActiveTenant(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
    });
    const active: Tenant[] = [];
    for (const membership of memberships) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: membership.tenantId },
      });
      if (tenant?.status === TenantStatus.ACTIVE) active.push(tenant);
    }
    if (active.length === 0) return null;
    if (active.length > 1) {
      throw new BadRequestException(
        'tenantSlug is required because this user belongs to more than one company',
      );
    }
    return active[0];
  }

  async refresh(dto: RefreshDto, meta: RequestMeta): Promise<AuthSession> {
    const claims = (() => {
      try {
        return this.jwt.verify(dto.refreshToken, 'refresh');
      } catch (err) {
        throw new UnauthorizedException(
          err instanceof Error ? err.message : 'Invalid refresh token',
        );
      }
    })();

    return this.tenantCtx.runWithTenantBypass(async () => {
      const tokenHash = hashRefresh(dto.refreshToken);
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash },
      });

      if (
        !stored ||
        stored.tenantId !== claims.tid! ||
        stored.userId !== claims.sub
      ) {
        if (stored) {
          await this.revokeFamily(stored.familyId, 'refresh.mismatch');
        }
        await this.writeAuditLog(
          claims.tid!,
          claims.sub,
          'auth.refresh.mismatch',
          meta,
        );
        throw new UnauthorizedException('Invalid refresh token');
      }

      if (stored.revokedAt) {
        await this.revokeFamily(stored.familyId, 'refresh.reuse');
        await this.writeAuditLog(
          stored.tenantId,
          stored.userId,
          'auth.refresh.reuse',
          meta,
        );
        throw new UnauthorizedException('Refresh token revoked');
      }

      if (stored.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedException('Refresh token expired');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: stored.userId },
      });
      if (!user || !user.isActive) {
        throw new UnauthorizedException('User no longer active');
      }

      const tenant = await this.prisma.tenant.findUnique({
        where: { id: stored.tenantId },
      });
      if (!tenant || tenant.status !== TenantStatus.ACTIVE) {
        throw new UnauthorizedException('Tenant unavailable');
      }

      const refreshSub = await this.prisma.subscription.findUnique({
        where: { tenantId: tenant.id },
      });
      denyIfNotEntitled(refreshSub?.plan, refreshSub?.status);

      // Re-verify the membership still exists (admin may have removed the user).
      const membership = await this.prisma.membership.findUnique({
        where: {
          userId_tenantId: { userId: user.id, tenantId: tenant.id },
        },
      });
      if (!membership) {
        await this.revokeFamily(stored.familyId, 'refresh.no_membership');
        await this.writeAuditLog(
          tenant.id,
          user.id,
          'auth.refresh.no_membership',
          meta,
        );
        throw new UnauthorizedException('Membership revoked');
      }

      const newTokens = await this.issueTokens(
        {
          userId: user.id,
          tenantId: tenant.id,
          membershipId: membership.id,
          role: membership.role,
        },
        meta,
        { familyId: stored.familyId },
      );

      const newHash = hashRefresh(newTokens.refreshToken);
      const newRow = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: newHash },
      });
      await this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date(), replacedById: newRow?.id ?? null },
      });

      await this.writeAuditLog(
        stored.tenantId,
        stored.userId,
        'auth.refresh.ok',
        meta,
      );

      return this.toSession(
        newTokens,
        { id: user.id, email: user.email, name: user.name },
        { id: membership.id, tenantId: tenant.id, role: membership.role },
        { id: tenant.id, slug: tenant.slug, name: tenant.name },
      );
    });
  }

  async logout(
    ctx: { userId: string; tenantId: string },
    refreshToken: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    await this.tenantCtx.runWithTenantBypass(async () => {
      if (refreshToken) {
        const tokenHash = hashRefresh(refreshToken);
        const stored = await this.prisma.refreshToken.findUnique({
          where: { tokenHash },
        });
        if (stored && stored.tenantId === ctx.tenantId && !stored.revokedAt) {
          await this.revokeFamily(stored.familyId, 'auth.logout');
        }
      } else {
        await this.prisma.refreshToken.updateMany({
          where: {
            userId: ctx.userId,
            tenantId: ctx.tenantId,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
      }
      await this.writeAuditLog(ctx.tenantId, ctx.userId, 'auth.logout', meta);
    });
  }

  /**
   * Issue access + refresh tokens for an existing membership row.
   * Used by the public invite acceptance flow so the new user is logged in
   * immediately (same response shape as `/auth/register` and `/auth/login`).
   */
  async issueSessionForMembership(
    userId: string,
    membershipId: string,
    meta: RequestMeta,
  ): Promise<AuthSession> {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const membership = await this.prisma.membership.findUnique({
        where: { id: membershipId },
        include: { user: true },
      });
      if (!membership || membership.userId !== userId) {
        throw new UnauthorizedException('Invalid membership');
      }
      const user = membership.user;
      if (!user.isActive) {
        throw new UnauthorizedException('User inactive');
      }
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: membership.tenantId },
      });
      if (!tenant || tenant.status !== TenantStatus.ACTIVE) {
        throw new UnauthorizedException('Tenant unavailable');
      }
      const issueSub = await this.prisma.subscription.findUnique({
        where: { tenantId: tenant.id },
      });
      denyIfNotEntitled(issueSub?.plan, issueSub?.status);
      const tokens = await this.issueTokens(
        {
          userId: user.id,
          tenantId: tenant.id,
          membershipId: membership.id,
          role: membership.role,
        },
        meta,
      );
      await this.writeAuditLog(tenant.id, user.id, 'auth.invite_accept_public', meta, {
        membershipId: membership.id,
        role: membership.role,
      });
      return this.toSession(
        tokens,
        { id: user.id, email: user.email, name: user.name },
        { id: membership.id, tenantId: tenant.id, role: membership.role },
        { id: tenant.id, slug: tenant.slug, name: tenant.name },
      );
    });
  }

  async me(userId: string, tenantId: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      const membership = await this.prisma.membership.findUnique({
        where: { userId_tenantId: { userId, tenantId } },
      });
      if (!membership) {
        throw new UnauthorizedException('No membership for this tenant');
      }
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
      });
      const subscription = await this.prisma.subscription.findUnique({
        where: { tenantId },
      });
      const memberCount = await this.prisma.membership.count({
        where: { tenantId },
      });
      const pendingInvites = await this.prisma.invitation.count({
        where: { tenantId, status: 'PENDING' },
      });
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        membership: {
          id: membership.id,
          role: membership.role,
        },
        tenant: tenant
          ? { id: tenant.id, slug: tenant.slug, name: tenant.name }
          : null,
        subscription: subscription
          ? {
              plan: subscription.plan,
              maxUsers: subscription.maxUsers,
              status: subscription.status,
              memberCount,
              pendingInvites,
              seatsRemaining: Math.max(0, subscription.maxUsers - memberCount),
              entitled:
                !entitlementEnforced() ||
                isEntitled(subscription.plan, subscription.status),
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
              currentPeriodEnd: subscription.currentPeriodEnd,
            }
          : null,
      };
    });
  }

  /**
   * Mint a short-lived global service token for backend workers.
   *
   * Protected at the controller layer by a shared `SERVICE_BOOTSTRAP_KEY`.
   * Service tokens do NOT carry `mid` or a tenant claim; tenant isolation for
   * worker-originated gRPC calls is enforced per request via `x-tenant-id`.
   */
  async mintServiceToken(
    dto: ServiceTokenDto,
    meta: RequestMeta,
  ): Promise<{
    token: string;
    tokenType: 'Bearer';
    tenantId: null;
    tenantSlug: null;
    expiresAt: number;
    label: string | null;
  }> {
    const label = dto.label?.trim().slice(0, 128) || null;

    const maxTtl = DEFAULT_SERVICE_TTL_SECONDS * 6;
    const requested = Number.isFinite(dto.ttlSeconds as number)
      ? Math.floor(Number(dto.ttlSeconds))
      : DEFAULT_SERVICE_TTL_SECONDS;
    const ttlSeconds = Math.min(Math.max(requested, 60), maxTtl);

    return this.tenantCtx.runWithTenantBypass(async () => {
      const jti = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const token = this.jwt.sign({
        subject: `service:${label || 'backend-worker'}`,
        role: 'SERVICE' as TokenRole,
        jti,
        type: 'service',
        ttlSeconds,
        // Service tokens explicitly omit `membershipId`.
      });

      await this.writeAuditLog(
        null,
        null,
        'auth.service_token.mint',
        meta,
        { label, ttlSeconds, jti },
      );

      return {
        token,
        tokenType: 'Bearer' as const,
        tenantId: null,
        tenantSlug: null,
        expiresAt: (now + ttlSeconds) * 1000,
        label,
      };
    });
  }

  /** Count recent `auth.login.fail` rows and compare against thresholds. */
  private async isLoginLocked(
    tenantId: string,
    email: string,
    ip: string | undefined,
  ): Promise<boolean> {
    const since = new Date(Date.now() - this.lockoutWindowSeconds * 1000);

    const emailFailures = await this.prisma.auditLog.count({
      where: {
        tenantId,
        action: 'auth.login.fail',
        createdAt: { gte: since },
        AND: [{ metadata: { path: ['email'], equals: email } }],
        NOT: { metadata: { path: ['lockoutReset'], equals: true } },
      },
    });
    if (emailFailures >= this.lockoutThreshold) return true;

    if (ip) {
      const ipFailures = await this.prisma.auditLog.count({
        where: {
          tenantId,
          action: 'auth.login.fail',
          createdAt: { gte: since },
          ip,
          NOT: { metadata: { path: ['lockoutReset'], equals: true } },
        },
      });
      if (ipFailures >= this.lockoutIpThreshold) return true;
    }

    return false;
  }

  private async resetLoginFailures(
    tenantId: string,
    email: string,
  ): Promise<void> {
    try {
      const since = new Date(Date.now() - this.lockoutWindowSeconds * 1000);
      const rows = await this.prisma.auditLog.findMany({
        where: {
          tenantId,
          action: 'auth.login.fail',
          createdAt: { gte: since },
          AND: [{ metadata: { path: ['email'], equals: email } }],
        },
        select: { id: true, metadata: true },
        take: 100,
      });
      for (const row of rows) {
        const md =
          row.metadata && typeof row.metadata === 'object'
            ? { ...(row.metadata as Record<string, unknown>) }
            : {};
        md.lockoutReset = true;
        await this.prisma.auditLog.update({
          where: { id: row.id },
          data: { metadata: md as any },
        });
      }
    } catch (err) {
      this.logger.warn(
        `[AuthService] failed to reset lockout counters: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async issueTokens(
    subject: IssueTokenSubject,
    meta: RequestMeta,
    opts: { familyId?: string } = {},
  ): Promise<AuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessToken = this.jwt.sign({
      subject: subject.userId,
      tenantId: subject.tenantId,
      membershipId: subject.membershipId,
      role: subject.role,
      jti: accessJti,
      type: 'access',
      ttlSeconds: this.accessTtlSeconds,
    });

    const refreshToken = this.jwt.sign({
      subject: subject.userId,
      tenantId: subject.tenantId,
      membershipId: subject.membershipId,
      role: subject.role,
      jti: refreshJti,
      type: 'refresh',
      ttlSeconds: this.refreshTtlSeconds,
    });

    const familyId = opts.familyId ?? randomUUID();
    const expiresAt = new Date((now + this.refreshTtlSeconds) * 1000);

    await this.prisma.refreshToken.create({
      data: {
        id: refreshJti,
        tenantId: subject.tenantId,
        userId: subject.userId,
        membershipId: subject.membershipId,
        tokenHash: hashRefresh(refreshToken),
        familyId,
        expiresAt,
        createdByIp: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    return {
      accessToken,
      refreshToken,
      accessExpiresAt: (now + this.accessTtlSeconds) * 1000,
      refreshExpiresAt: expiresAt.getTime(),
      tokenType: 'Bearer',
    };
  }

  private async revokeFamily(familyId: string, _reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private toSession(
    tokens: AuthTokens,
    user: { id: string; email: string; name: string | null },
    membership: { id: string; tenantId: string; role: MembershipRole },
    tenant: { id: string; slug: string; name: string },
  ): AuthSession {
    return {
      ...tokens,
      user,
      membership,
      tenant,
    };
  }

  private async writeAuditLog(
    tenantId: string | null,
    userId: string | null,
    action: string,
    meta: RequestMeta,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: tenantId ?? undefined,
          userId: userId ?? undefined,
          action,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: extra ? (extra as any) : undefined,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[AuthService] audit write failed for ${action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function hashRefresh(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
