import { Injectable } from '@nestjs/common';
import { InviteStatus, Plan, Prisma, Subscription, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { planToMaxUsers } from './plan-limits';
import { SeatLimitReachedException } from './seat-limit.exception';

export interface SeatCapacity {
  plan: Plan;
  status: SubscriptionStatus;
  maxUsers: number;
  effectiveMaxUsers: number;
  memberCount: number;
  pendingInvites: number;
  seatsUsed: number;
  seatsRemaining: number;
  pendingPlan: Plan | null;
  pendingMaxUsers: number | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  seatLimitHoldReason: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  updatedAt: Date;
}

type DbClient = Prisma.TransactionClient | PrismaService;

@Injectable()
export class SeatCapacityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async snapshot(tenantId: string, client?: DbClient): Promise<SeatCapacity> {
    const db = client ?? this.prisma;
    return this.tenantCtx.runWithTenantBypass(async () => {
      let sub = await db.subscription.findUnique({ where: { tenantId } });
      if (!sub) {
        sub = await db.subscription.create({
          data: {
            tenantId,
            plan: Plan.FREE,
            maxUsers: planToMaxUsers(Plan.FREE),
            status: SubscriptionStatus.ACTIVE,
          },
        });
      }
      sub = await this.applyDuePending(db, sub);
      const [memberCount, pendingInvites] = await Promise.all([
        db.membership.count({ where: { tenantId } }),
        db.invitation.count({
          where: { tenantId, status: InviteStatus.PENDING },
        }),
      ]);
      return toCapacity(sub, memberCount, pendingInvites);
    });
  }

  async assertCanAddSeat(tenantId: string, client?: DbClient): Promise<SeatCapacity> {
    const cap = await this.snapshot(tenantId, client);
    if (cap.seatsUsed >= cap.effectiveMaxUsers) {
      throw new SeatLimitReachedException(
        `Seat limit reached (${cap.seatsUsed}/${cap.effectiveMaxUsers}). Upgrade your plan to invite more members.`,
        {
          plan: cap.plan,
          maxUsers: cap.effectiveMaxUsers,
          memberCount: cap.memberCount,
          pendingInvites: cap.pendingInvites,
          seatsUsed: cap.seatsUsed,
          pendingPlan: cap.pendingPlan,
        },
      );
    }
    return cap;
  }

  async assertFitsMaxUsers(
    tenantId: string,
    nextMaxUsers: number,
    client?: DbClient,
  ): Promise<SeatCapacity> {
    const cap = await this.snapshot(tenantId, client);
    if (cap.seatsUsed > nextMaxUsers) {
      throw new SeatLimitReachedException(
        `Cannot switch plan: current seats used (${cap.seatsUsed}) exceeds destination limit (${nextMaxUsers}). Remove members or pending invites first.`,
        {
          plan: cap.plan,
          maxUsers: nextMaxUsers,
          memberCount: cap.memberCount,
          pendingInvites: cap.pendingInvites,
          seatsUsed: cap.seatsUsed,
        },
      );
    }
    return cap;
  }

  /**
   * Serialize seat mutations per tenant. No-op on the in-memory Prisma fake.
   */
  async lockTenant(client: DbClient, tenantId: string): Promise<void> {
    const raw = (client as Prisma.TransactionClient).$queryRaw;
    if (typeof raw !== 'function') return;
    await (client as Prisma.TransactionClient).$queryRaw`
      SELECT 1 FROM "Subscription" WHERE "tenantId" = ${tenantId} FOR UPDATE
    `;
  }

  private async applyDuePending(db: DbClient, sub: Subscription): Promise<Subscription> {
    if (
      !sub.pendingPlan ||
      !sub.currentPeriodEnd ||
      sub.currentPeriodEnd.getTime() > Date.now()
    ) {
      return sub;
    }
    const nextMax = sub.pendingMaxUsers ?? planToMaxUsers(sub.pendingPlan);
    const used = await db.membership.count({ where: { tenantId: sub.tenantId } });
    const pending = await db.invitation.count({
      where: { tenantId: sub.tenantId, status: InviteStatus.PENDING },
    });
    if (used + pending > nextMax) {
      return db.subscription.update({
        where: { id: sub.id },
        data: {
          seatLimitHoldReason: `pending ${sub.pendingPlan} blocked: ${used + pending} seats used > ${nextMax}`,
        },
      });
    }
    return db.subscription.update({
      where: { id: sub.id },
      data: {
        plan: sub.pendingPlan,
        maxUsers: nextMax,
        pendingPlan: null,
        pendingMaxUsers: null,
        seatLimitHoldReason: null,
      },
    });
  }
}

function toCapacity(
  sub: Subscription,
  memberCount: number,
  pendingInvites: number,
): SeatCapacity {
  const effectiveMaxUsers = sub.pendingMaxUsers ?? sub.maxUsers;
  const seatsUsed = memberCount + pendingInvites;
  return {
    plan: sub.plan,
    status: sub.status,
    maxUsers: sub.maxUsers,
    effectiveMaxUsers,
    memberCount,
    pendingInvites,
    seatsUsed,
    seatsRemaining: Math.max(0, effectiveMaxUsers - seatsUsed),
    pendingPlan: sub.pendingPlan,
    pendingMaxUsers: sub.pendingMaxUsers,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    seatLimitHoldReason: sub.seatLimitHoldReason,
    stripeCustomerId: sub.stripeCustomerId,
    stripeSubscriptionId: sub.stripeSubscriptionId,
    updatedAt: sub.updatedAt,
  };
}
