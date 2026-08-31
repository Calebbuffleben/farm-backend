import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import {
  InviteStatus,
  MembershipRole,
  SubscriptionStatus,
  Plan,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { ARGON2_OPTIONS } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import type { AuthSession } from '../auth/auth.service';
import { planToMaxUsers } from '../billing/plan-limits';
import { denyIfNotEntitled } from '../billing/entitlement';

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface InvitationSummary {
  id: string;
  email: string;
  role: MembershipRole;
  status: InviteStatus;
  expiresAt: Date;
  createdAt: Date;
  invitedById: string | null;
}

export interface CreatedInvitation extends InvitationSummary {
  /** Plaintext token — returned ONLY on creation. Never stored. */
  token: string;
}

/**
 * HTTP 402 Payment Required — used to surface seat-limit exhaustion back
 * to the client. The frontend keys on this status to render the upgrade CTA.
 */
export class SeatLimitReachedException extends HttpException {
  constructor(message: string, public readonly detail: Record<string, unknown>) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'SeatLimitReached',
        message,
        ...detail,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Create a pending invitation. Admin-only at the controller layer.
   *
   * Seat accounting: memberships + pending invitations must be STRICTLY
   * less than `subscription.maxUsers`. The admin cannot invite more
   * people than will fit in the current plan.
   */
  async create(
    tenantId: string,
    actorUserId: string,
    actorMembershipId: string,
    email: string,
    role: MembershipRole,
    meta: RequestMeta,
  ): Promise<CreatedInvitation> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail.includes('@')) {
      throw new BadRequestException('Invalid email');
    }
    if (role === MembershipRole.OWNER) {
      // OWNER can only be assigned via registration or explicit promotion.
      throw new ForbiddenException(
        'Cannot invite a user as OWNER — invite as ADMIN/MANAGER/MEMBER and promote later',
      );
    }

    return this.tenantCtx.runWithTenantBypass(async () => {
      const sub = await this.prisma.subscription.findUnique({
        where: { tenantId },
      });
      if (!sub) {
        throw new NotFoundException('Subscription missing for tenant');
      }
      if (sub.status === SubscriptionStatus.CANCELED) {
        throw new ForbiddenException(
          'Subscription canceled — upgrade to invite members again',
        );
      }

      // Already a member?
      const existingUser = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (existingUser) {
        const existingMembership = await this.prisma.membership.findUnique({
          where: {
            userId_tenantId: { userId: existingUser.id, tenantId },
          },
        });
        if (existingMembership) {
          throw new ConflictException('User is already a member of this tenant');
        }
      }

      // Any PENDING invite already out for this email?
      const existingInvite = await this.prisma.invitation.findFirst({
        where: {
          tenantId,
          email: normalizedEmail,
          status: InviteStatus.PENDING,
        },
      });
      if (existingInvite) {
        throw new ConflictException(
          'A pending invitation already exists for this email',
        );
      }

      const [memberCount, pendingInvites] = await Promise.all([
        this.prisma.membership.count({ where: { tenantId } }),
        this.prisma.invitation.count({
          where: { tenantId, status: InviteStatus.PENDING },
        }),
      ]);
      const seatsUsed = memberCount + pendingInvites;
      if (seatsUsed >= sub.maxUsers) {
        throw new SeatLimitReachedException(
          `Seat limit reached (${seatsUsed}/${sub.maxUsers}). Upgrade your plan to invite more members.`,
          {
            plan: sub.plan,
            maxUsers: sub.maxUsers,
            memberCount,
            pendingInvites,
            seatsUsed,
          },
        );
      }

      const tokenPlain = generateInvitationToken();
      const tokenHash = hashToken(tokenPlain);
      const expiresAt = new Date(Date.now() + DEFAULT_INVITE_TTL_MS);

      const created = await this.prisma.invitation.create({
        data: {
          tenantId,
          email: normalizedEmail,
          role,
          tokenHash,
          invitedById: actorUserId,
          status: InviteStatus.PENDING,
          expiresAt,
        },
      });

      await this.prisma.auditLog.create({
        data: {
          tenantId,
          userId: actorUserId,
          action: 'invite.sent',
          target: `invitation:${created.id}`,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: {
            email: normalizedEmail,
            role,
            invitedByMembershipId: actorMembershipId,
          } as any,
        },
      });

      return {
        id: created.id,
        email: created.email,
        role: created.role,
        status: created.status,
        expiresAt: created.expiresAt,
        createdAt: created.createdAt,
        invitedById: created.invitedById,
        token: tokenPlain,
      };
    });
  }

  async listPending(tenantId: string): Promise<InvitationSummary[]> {
    const rows = await this.prisma.invitation.findMany({
      where: { tenantId, status: InviteStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      status: r.status,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      invitedById: r.invitedById,
    }));
  }

  async revoke(
    tenantId: string,
    actorUserId: string,
    invitationId: string,
    meta: RequestMeta,
  ): Promise<{ revoked: true }> {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const invite = await this.prisma.invitation.findUnique({
        where: { id: invitationId },
      });
      if (!invite || invite.tenantId !== tenantId) {
        throw new NotFoundException('Invitation not found');
      }
      if (invite.status !== InviteStatus.PENDING) {
        throw new ConflictException(`Invitation is already ${invite.status}`);
      }
      await this.prisma.invitation.update({
        where: { id: invitationId },
        data: { status: InviteStatus.REVOKED, revokedAt: new Date() },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          userId: actorUserId,
          action: 'invite.revoked',
          target: `invitation:${invitationId}`,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: { email: invite.email } as any,
        },
      });
      return { revoked: true as const };
    });
  }

  /**
   * Authenticated accept flow. The caller is a logged-in user (from
   * ANY tenant). The invitation token identifies the target tenant and
   * the user's email on the invitation must match.
   *
   * Returns the newly-created membership (the caller should switch to
   * the new tenant by logging in with that tenantSlug).
   */
  async acceptAuthenticated(
    callerUserId: string,
    callerEmail: string,
    token: string,
    meta: RequestMeta,
  ): Promise<{
    membershipId: string;
    tenantId: string;
    tenantSlug: string;
    role: MembershipRole;
  }> {
    const invite = await this.loadAndValidateInvite(token);
    if (invite.email !== callerEmail.trim().toLowerCase()) {
      await this.writeInviteAudit(
        invite.tenantId,
        callerUserId,
        'invite.accept.email_mismatch',
        invite.id,
        meta,
      );
      throw new ForbiddenException(
        'Invitation email does not match the authenticated user',
      );
    }

    return this.consumeInvite(invite.id, callerUserId, meta);
  }

  /**
   * Public accept flow — creates a new User from the invitation payload.
   * Rejects if the email is already registered (the caller must use the
   * authenticated flow in that case, to prove they own the account).
   */
  async acceptPublic(
    token: string,
    password: string,
    name: string | undefined,
    meta: RequestMeta,
  ): Promise<AuthSession> {
    const invite = await this.loadAndValidateInvite(token);

    return this.tenantCtx.runWithTenantBypass(async () => {
      const existing = await this.prisma.user.findUnique({
        where: { email: invite.email },
      });
      if (existing) {
        throw new ConflictException(
          'This email already has an account. Log in first and call /invites/accept instead.',
        );
      }

      const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
      const user = await this.prisma.user.create({
        data: {
          email: invite.email,
          passwordHash,
          name: name?.trim() || null,
          isActive: true,
        },
      });

      const summary = await this.consumeInvite(invite.id, user.id, meta);
      return this.auth.issueSessionForMembership(
        user.id,
        summary.membershipId,
        meta,
      );
    });
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private async loadAndValidateInvite(token: string): Promise<{
    id: string;
    tenantId: string;
    email: string;
    role: MembershipRole;
    status: InviteStatus;
    expiresAt: Date;
  }> {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const tokenHash = hashToken(token);
      const invite = await this.prisma.invitation.findUnique({
        where: { tokenHash },
      });
      if (!invite) {
        throw new NotFoundException('Invalid or expired invitation');
      }
      if (invite.status !== InviteStatus.PENDING) {
        throw new ForbiddenException(`Invitation is ${invite.status}`);
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        await this.prisma.invitation
          .update({
            where: { id: invite.id },
            data: { status: InviteStatus.EXPIRED },
          })
          .catch(() => undefined);
        throw new ForbiddenException('Invitation expired');
      }
      return invite;
    });
  }

  private async consumeInvite(
    invitationId: string,
    userId: string,
    meta: RequestMeta,
  ): Promise<{
    membershipId: string;
    tenantId: string;
    tenantSlug: string;
    role: MembershipRole;
  }> {
    return this.tenantCtx.runWithTenantBypass(async () => {
      // Re-fetch atomically to close races (2 accepts in parallel, limit change, etc.)
      const invite = await this.prisma.invitation.findUnique({
        where: { id: invitationId },
      });
      if (!invite || invite.status !== InviteStatus.PENDING) {
        throw new NotFoundException('Invitation not found or no longer valid');
      }

      const tenant = await this.prisma.tenant.findUnique({
        where: { id: invite.tenantId },
      });
      if (!tenant) {
        throw new NotFoundException('Tenant not found');
      }

      const sub = await this.prisma.subscription.findUnique({
        where: { tenantId: invite.tenantId },
      });
      denyIfNotEntitled(sub?.plan, sub?.status);
      // Re-check the seat limit at accept-time (admin may have downgraded,
      // or someone else accepted in parallel).
      const memberCount = await this.prisma.membership.count({
        where: { tenantId: invite.tenantId },
      });
      const maxUsers = sub?.maxUsers ?? planToMaxUsers(Plan.FREE);
      if (memberCount >= maxUsers) {
        await this.prisma.invitation.update({
          where: { id: invite.id },
          data: { status: InviteStatus.EXPIRED },
        });
        await this.writeInviteAudit(
          invite.tenantId,
          userId,
          'invite.accept.seat_limit',
          invite.id,
          meta,
          { memberCount, maxUsers },
        );
        throw new SeatLimitReachedException(
          `Seat limit reached (${memberCount}/${maxUsers}). Ask an admin to upgrade the plan.`,
          {
            plan: sub?.plan ?? Plan.FREE,
            maxUsers,
            memberCount,
          },
        );
      }

      // Defend against idempotency: duplicate membership => just mark
      // the invite accepted and return the existing row.
      const existingMembership = await this.prisma.membership.findUnique({
        where: { userId_tenantId: { userId, tenantId: invite.tenantId } },
      });
      let membershipId: string;
      let role: MembershipRole;
      if (existingMembership) {
        membershipId = existingMembership.id;
        role = existingMembership.role;
      } else {
        // Find the inviter's membership for bookkeeping (platform bootstrap
        // invites may have no inviter user).
        const inviterMembership = invite.invitedById
          ? await this.prisma.membership.findFirst({
              where: {
                userId: invite.invitedById,
                tenantId: invite.tenantId,
              },
            })
          : null;
        const created = await this.prisma.membership.create({
          data: {
            userId,
            tenantId: invite.tenantId,
            role: invite.role,
            invitedBy: inviterMembership?.id ?? null,
          },
        });
        membershipId = created.id;
        role = created.role;
      }

      await this.prisma.invitation.update({
        where: { id: invite.id },
        data: { status: InviteStatus.ACCEPTED, acceptedAt: new Date() },
      });

      await this.writeInviteAudit(
        invite.tenantId,
        userId,
        'invite.accepted',
        invite.id,
        meta,
        { membershipId, role },
      );

      return {
        membershipId,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        role,
      };
    });
  }

  private async writeInviteAudit(
    tenantId: string,
    userId: string | null,
    action: string,
    invitationId: string,
    meta: RequestMeta,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          userId: userId ?? undefined,
          action,
          target: `invitation:${invitationId}`,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: extra ? (extra as any) : undefined,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[InvitationsService] audit write failed for ${action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function generateInvitationToken(): string {
  // 256 bits. Base64url-encoded to keep URLs clean.
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
