import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Plan, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { entitlementEnforced, isEntitled } from './entitlement';
import { isPublicPlan, planToMaxUsers } from './plan-limits';
import { SeatCapacityService } from './seat-capacity.service';
import { SeatLimitReachedException } from './seat-limit.exception';

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
  seatsUsed: number;
  seatsRemaining: number;
  entitled: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  pendingPlan: Plan | null;
  pendingMaxUsers: number | null;
  hasStripeCustomer: boolean;
  stripeLinked: boolean;
  seatLimitHoldReason: string | null;
  updatedAt: Date;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly seats: SeatCapacityService,
  ) {}

  async getSubscription(tenantId: string): Promise<SubscriptionSnapshot> {
    const cap = await this.seats.snapshot(tenantId);
    return toSnapshot(cap);
  }

  /**
   * Local plan switch (dev / ALLOW_FREE_PLAN_SWITCH). Production uses Stripe.
   */
  async changePlan(
    tenantId: string,
    userId: string,
    plan: Plan,
    meta: RequestMeta,
  ): Promise<SubscriptionSnapshot> {
    if (!isPublicPlan(plan) && plan !== Plan.ENTERPRISE) {
      throw new BadRequestException(`Plan "${plan}" is not available`);
    }
    return this.tenantCtx.runWithTenantBypass(async () => {
      const current = await this.prisma.subscription.findUnique({
        where: { tenantId },
      });
      if (!current) {
        throw new NotFoundException('Subscription not found for tenant');
      }
      const newMax =
        plan === Plan.ENTERPRISE
          ? Math.max(current.maxUsers, planToMaxUsers(plan))
          : planToMaxUsers(plan);
      try {
        await this.seats.assertFitsMaxUsers(tenantId, newMax);
      } catch (err) {
        if (err instanceof SeatLimitReachedException) {
          throw err;
        }
        throw err;
      }

      const updated = await this.prisma.subscription.update({
        where: { tenantId },
        data: {
          plan,
          maxUsers: newMax,
          status: SubscriptionStatus.ACTIVE,
          pendingPlan: null,
          pendingMaxUsers: null,
          seatLimitHoldReason: null,
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
          },
        },
      });

      return this.getSubscription(tenantId);
    });
  }
}

function toSnapshot(cap: Awaited<ReturnType<SeatCapacityService['snapshot']>>): SubscriptionSnapshot {
  return {
    plan: cap.plan,
    maxUsers: cap.maxUsers,
    status: cap.status,
    memberCount: cap.memberCount,
    pendingInvites: cap.pendingInvites,
    seatsUsed: cap.seatsUsed,
    seatsRemaining: cap.seatsRemaining,
    entitled: !entitlementEnforced() || isEntitled(cap.plan, cap.status, cap.currentPeriodEnd),
    cancelAtPeriodEnd: cap.cancelAtPeriodEnd,
    currentPeriodEnd: cap.currentPeriodEnd,
    pendingPlan: cap.pendingPlan,
    pendingMaxUsers: cap.pendingMaxUsers,
    hasStripeCustomer: Boolean(cap.stripeCustomerId),
    stripeLinked: Boolean(cap.stripeSubscriptionId),
    seatLimitHoldReason: cap.seatLimitHoldReason,
    updatedAt: cap.updatedAt,
  };
}
