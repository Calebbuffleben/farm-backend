import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembershipRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface MemberSummary {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: MembershipRole;
  createdAt: Date;
  lastLoginAt: Date | null;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async list(tenantId: string): Promise<MemberSummary[]> {
    const rows = await this.prisma.membership.findMany({
      where: { tenantId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            lastLoginAt: true,
            phone: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      phone: m.user.phone,
      role: m.role,
      createdAt: m.createdAt,
      lastLoginAt: m.user.lastLoginAt,
    }));
  }

  /**
   * Change a member's role. Rules:
   *  - Only admins (OWNER or ADMIN) may call this.
   *  - Only an OWNER may change another OWNER's role.
   *  - The last OWNER cannot be demoted — there must always be at least
   *    one OWNER per tenant (invariant to keep billing/ownership sane).
   */
  async changeRole(
    tenantId: string,
    actorUserId: string,
    actorRole: MembershipRole,
    targetMembershipId: string,
    newRole: MembershipRole,
    meta: RequestMeta,
  ): Promise<MemberSummary> {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const target = await this.prisma.membership.findUnique({
        where: { id: targetMembershipId },
        include: { user: true },
      });
      if (!target || target.tenantId !== tenantId) {
        throw new NotFoundException('Member not found in tenant');
      }

      if (
        target.role === MembershipRole.OWNER &&
        actorRole !== MembershipRole.OWNER
      ) {
        throw new ForbiddenException('Only an OWNER can modify another OWNER');
      }

      if (target.role === newRole) {
        // No-op — return current snapshot.
        return this.toSummary(target);
      }

      if (target.role === MembershipRole.OWNER && newRole !== MembershipRole.OWNER) {
        const ownerCount = await this.prisma.membership.count({
          where: { tenantId, role: MembershipRole.OWNER },
        });
        if (ownerCount <= 1) {
          throw new ConflictException(
            'Cannot demote the last OWNER — promote another member first.',
          );
        }
      }

      const updated = await this.prisma.membership.update({
        where: { id: targetMembershipId },
        data: { role: newRole },
        include: { user: true },
      });

      await this.prisma.auditLog.create({
        data: {
          tenantId,
          userId: actorUserId,
          action: 'member.role_changed',
          target: `membership:${targetMembershipId}`,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: {
            from: target.role,
            to: newRole,
            targetUserId: target.userId,
          } as any,
        },
      });

      return this.toSummary(updated);
    });
  }

  /**
   * Remove a member from the tenant. Rules:
   *  - Admin-only.
   *  - Last OWNER cannot be removed.
   *  - Admins can remove other members and admins. Only OWNER can remove
   *    another OWNER.
   *  - Actor cannot remove themselves if they're the last OWNER.
   *
   * Side effect: revokes all active refresh tokens for this (user, tenant)
   * pair so the removed user loses access immediately on next refresh.
   */
  async remove(
    tenantId: string,
    actorUserId: string,
    actorRole: MembershipRole,
    targetMembershipId: string,
    meta: RequestMeta,
  ): Promise<{ removed: true }> {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const target = await this.prisma.membership.findUnique({
        where: { id: targetMembershipId },
      });
      if (!target || target.tenantId !== tenantId) {
        throw new NotFoundException('Member not found in tenant');
      }
      if (
        target.role === MembershipRole.OWNER &&
        actorRole !== MembershipRole.OWNER
      ) {
        throw new ForbiddenException('Only an OWNER can remove another OWNER');
      }
      if (target.role === MembershipRole.OWNER) {
        const ownerCount = await this.prisma.membership.count({
          where: { tenantId, role: MembershipRole.OWNER },
        });
        if (ownerCount <= 1) {
          throw new ConflictException('Cannot remove the last OWNER');
        }
      }

      await this.prisma.membership.delete({ where: { id: targetMembershipId } });

      // Invalidate refresh tokens so the removed user cannot continue to
      // refresh into this tenant.
      await this.prisma.refreshToken.updateMany({
        where: {
          tenantId,
          userId: target.userId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });

      await this.prisma.auditLog.create({
        data: {
          tenantId,
          userId: actorUserId,
          action: 'member.removed',
          target: `membership:${targetMembershipId}`,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: {
            targetUserId: target.userId,
            targetRole: target.role,
          } as any,
        },
      });

      return { removed: true as const };
    });
  }

  private toSummary(m: {
    id: string;
    userId: string;
    role: MembershipRole;
    createdAt: Date;
    user: {
      email: string;
      name: string | null;
      lastLoginAt: Date | null;
      phone: string | null;
    };
  }): MemberSummary {
    return {
      id: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      phone: m.user.phone,
      role: m.role,
      createdAt: m.createdAt,
      lastLoginAt: m.user.lastLoginAt,
    };
  }
}
