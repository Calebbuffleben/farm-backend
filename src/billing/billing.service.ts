import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Plan, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { entitlementEnforced, isEntitled } from './entitlement';
import { planToMaxUsers } from './plan-limits';

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface SubscriptionSnapshot {
  plan: Plan;
  maxUsers: number;
  status: SubscriptionStatus;
  memberCount: number;
  pendingInvites: number;
  seatsRemaining: number;
  entitled: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  updatedAt: Date;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Load the current tenant subscription + live seat usage. Auto-creates a
   * FREE plan row if the tenant was somehow bootstrapped without one
   * (defensive — registration always creates a subscription).
   */
  async getSubscription(tenantId: string): Promise<SubscriptionSnapshot> {
    let sub = await this.prisma.subscription.findUnique({
      where: { tenantId },
    });
    if (!sub) {
      // Defensive: recreate missing subscription as FREE.
      sub = await this.prisma.subscription.create({
        data: {
          tenantId,
          plan: Plan.FREE,
          maxUsers: planToMaxUsers(Plan.FREE),
          status: SubscriptionStatus.ACTIVE,
        },
      });
    }

    const [memberCount, pendingInvites] = await Promise.all([
      this.prisma.membership.count({ where: { tenantId } }),
      this.prisma.invitation.count({
        where: { tenantId, status: 'PENDING' },
      }),
    ]);

    return toSnapshot(sub, memberCount, pendingInvites);
  }

  /**
   * Upgrade (or downgrade) the tenant's plan. Hard-coded plan→seat map.
   * Downgrades that would put `memberCount > maxUsers` are rejected —
   * admin must remove members first.
   */
  async changePlan(
    tenantId: string,
    userId: string,
    plan: Plan,
    meta: RequestMeta,
  ): Promise<SubscriptionSnapshot> {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const current = await this.prisma.subscription.findUnique({
        where: { tenantId },
      });
      if (!current) {
        throw new NotFoundException('Subscription not found for tenant');
      }
      if (!Object.values(Plan).includes(plan)) {
        throw new BadRequestException(`Unknown plan "${plan}"`);
      }
      const newMax = planToMaxUsers(plan);
      const memberCount = await this.prisma.membership.count({
        where: { tenantId },
      });
      if (memberCount > newMax) {
        throw new ConflictException(
          `Cannot switch to ${plan}: current seats used (${memberCount}) exceeds plan limit (${newMax}). Remove members first.`,
        );
      }

      const updated = await this.prisma.subscription.update({
        where: { tenantId },
        data: {
          plan,
          maxUsers: newMax,
          // Upgrades always flip status back to ACTIVE. Downgrades keep status.
          status:
            current.status === SubscriptionStatus.ACTIVE
              ? SubscriptionStatus.ACTIVE
              : SubscriptionStatus.ACTIVE,
        },
      });

      await this.prisma.auditLog.create({
        data: {
          tenantId,
          userId,
          action: 'billing.plan_changed',
          target: `tenant:${tenantId}`,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: {
            from: current.plan,
            to: updated.plan,
            fromMax: current.maxUsers,
            toMax: updated.maxUsers,
          } as any,
        },
      });

      const pendingInvites = await this.prisma.invitation.count({
        where: { tenantId, status: 'PENDING' },
      });

      return toSnapshot(updated, memberCount, pendingInvites);
    });
  }
}

function toSnapshot(
  sub: {
    plan: Plan;
    maxUsers: number;
    status: SubscriptionStatus;
    cancelAtPeriodEnd?: boolean;
    currentPeriodEnd?: Date | null;
    updatedAt: Date;
  },
  memberCount: number,
  pendingInvites: number,
): SubscriptionSnapshot {
  return {
    plan: sub.plan,
    maxUsers: sub.maxUsers,
    status: sub.status,
    memberCount,
    pendingInvites,
    seatsRemaining: Math.max(0, sub.maxUsers - memberCount),
    entitled: !entitlementEnforced() || isEntitled(sub.plan, sub.status),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: sub.currentPeriodEnd ?? null,
    updatedAt: sub.updatedAt,
  };
}
