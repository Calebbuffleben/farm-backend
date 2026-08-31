import { Injectable, NotFoundException } from '@nestjs/common';
import {
  MembershipRole,
  PendingCheckoutStatus,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';

import { PLAN_MONTHLY_PRICE } from '../billing/plan-limits';
import { StripeBillingService } from '../billing/stripe-billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import type {
  BillingListQueryDto,
  CheckoutListQueryDto,
} from './dto/platform-admin.dto';

const DEFAULT_LIMIT = 25;
const BILLING_AUDIT_ACTIONS = {
  startsWithBilling: 'billing.',
  startsWithPlatformBilling: 'platform.billing.',
  tenantUpdated: 'platform.tenant.billing_updated',
} as const;

@Injectable()
export class PlatformBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly stripeBilling: StripeBillingService,
  ) {}

  summary() {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const groups = await this.prisma.subscription.groupBy({
        by: ['plan', 'status'],
        _count: { _all: true },
      });
      const mrr = groups.reduce((sum, row) => {
        if (row.status !== SubscriptionStatus.ACTIVE) return sum;
        return sum + (PLAN_MONTHLY_PRICE[row.plan] ?? 0) * row._count._all;
      }, 0);
      const pastDueCount = groups
        .filter((row) => row.status === SubscriptionStatus.PAST_DUE)
        .reduce((sum, row) => sum + row._count._all, 0);
      const cancelAtPeriodEndCount = await this.prisma.subscription.count({
        where: { cancelAtPeriodEnd: true },
      });
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const now = new Date();
      const [pending, completed, abandoned] = await Promise.all([
        this.prisma.pendingCheckout.count({
          where: {
            createdAt: { gte: since },
            status: PendingCheckoutStatus.PENDING,
            expiresAt: { gte: now },
          },
        }),
        this.prisma.pendingCheckout.count({
          where: {
            createdAt: { gte: since },
            status: PendingCheckoutStatus.COMPLETED,
          },
        }),
        this.prisma.pendingCheckout.count({
          where: {
            createdAt: { gte: since },
            status: PendingCheckoutStatus.PENDING,
            expiresAt: { lt: now },
          },
        }),
      ]);
      return {
        bySubscription: groups.map((row) => ({
          plan: row.plan,
          status: row.status,
          count: row._count._all,
        })),
        mrr,
        pastDueCount,
        cancelAtPeriodEndCount,
        checkouts30d: { pending, completed, abandoned },
      };
    });
  }

  listSubscriptions(query: BillingListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;
    return this.tenantCtx.runWithTenantBypass(async () => {
      const where: Prisma.SubscriptionWhereInput = {
        ...(query.plan ? { plan: query.plan } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.source === 'stripe'
          ? { stripeSubscriptionId: { not: null } }
          : query.source === 'manual'
            ? { stripeSubscriptionId: null }
            : {}),
        ...(query.q?.trim()
          ? {
              tenant: {
                OR: [
                  { name: { contains: query.q.trim(), mode: 'insensitive' } },
                  { slug: { contains: query.q.trim(), mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      };
      const [total, rows] = await Promise.all([
        this.prisma.subscription.count({ where }),
        this.prisma.subscription.findMany({
          where,
          include: {
            tenant: { select: { id: true, slug: true, name: true, status: true } },
          },
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      const tenantIds = rows.map((row) => row.tenantId);
      const memberCounts = await this.prisma.membership.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds } },
        _count: { _all: true },
      });
      const countMap = new Map(memberCounts.map((c) => [c.tenantId, c._count._all]));
      return {
        total,
        items: rows.map((row) => ({
          tenant: row.tenant,
          plan: row.plan,
          status: row.status,
          maxUsers: row.maxUsers,
          memberCount: countMap.get(row.tenantId) ?? 0,
          source: row.stripeSubscriptionId ? 'stripe' : 'manual',
          stripeCustomerId: row.stripeCustomerId,
          stripeSubscriptionId: row.stripeSubscriptionId,
          stripePriceId: row.stripePriceId,
          currentPeriodEnd: row.currentPeriodEnd,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          updatedAt: row.updatedAt,
        })),
      };
    });
  }

  getTenantBilling(tenantId: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        include: { subscription: true },
      });
      if (!tenant) throw new NotFoundException('Tenant not found');
      const [owner, memberCount, pendingInvites, timeline] = await Promise.all([
        this.prisma.membership.findFirst({
          where: { tenantId, role: MembershipRole.OWNER },
          include: { user: { select: { id: true, email: true, name: true } } },
        }),
        this.prisma.membership.count({ where: { tenantId } }),
        this.prisma.invitation.count({
          where: { tenantId, status: 'PENDING' },
        }),
        this.prisma.auditLog.findMany({
          where: {
            tenantId,
            OR: [
              { action: { startsWith: BILLING_AUDIT_ACTIONS.startsWithBilling } },
              { action: { startsWith: BILLING_AUDIT_ACTIONS.startsWithPlatformBilling } },
              { action: BILLING_AUDIT_ACTIONS.tenantUpdated },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);
      const pendingCheckouts = await this.prisma.pendingCheckout.findMany({
        where: {
          OR: [
            { tenantId },
            ...(owner?.user.email ? [{ email: owner.user.email }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          email: true,
          tenantName: true,
          tenantSlug: true,
          plan: true,
          status: true,
          stripeCheckoutSessionId: true,
          expiresAt: true,
          createdAt: true,
          tenantId: true,
        },
      });
      return {
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          status: tenant.status,
        },
        owner: owner?.user ?? null,
        subscription: tenant.subscription,
        memberCount,
        pendingInvites,
        timeline,
        pendingCheckouts,
      };
    });
  }

  listCheckouts(query: CheckoutListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const now = new Date();
    return this.tenantCtx.runWithTenantBypass(async () => {
      const where: Prisma.PendingCheckoutWhereInput = {
        ...(query.q?.trim()
          ? {
              OR: [
                { email: { contains: query.q.trim(), mode: 'insensitive' } },
                { tenantSlug: { contains: query.q.trim(), mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(query.status === 'ABANDONED'
          ? { status: PendingCheckoutStatus.PENDING, expiresAt: { lt: now } }
          : query.status === 'PENDING'
            ? { status: PendingCheckoutStatus.PENDING, expiresAt: { gte: now } }
            : query.status
              ? { status: query.status as PendingCheckoutStatus }
              : {}),
      };
      const [total, items] = await Promise.all([
        this.prisma.pendingCheckout.count({ where }),
        this.prisma.pendingCheckout.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            email: true,
            tenantName: true,
            tenantSlug: true,
            plan: true,
            status: true,
            stripeCheckoutSessionId: true,
            expiresAt: true,
            createdAt: true,
            tenantId: true,
          },
        }),
      ]);
      return {
        total,
        items: items.map((row) => ({
          ...row,
          status:
            row.status === PendingCheckoutStatus.PENDING && row.expiresAt < now
              ? 'ABANDONED'
              : row.status,
        })),
      };
    });
  }

  async sync(tenantId: string) {
    await this.stripeBilling.syncFromStripe(tenantId);
    await this.audit(tenantId, 'platform.billing.synced', tenantId, {});
    return this.getTenantBilling(tenantId);
  }

  async cancel(tenantId: string) {
    await this.stripeBilling.setCancelAtPeriodEnd(tenantId, true);
    await this.audit(tenantId, 'platform.billing.cancel_requested', tenantId, {});
    return { ok: true };
  }

  async reactivate(tenantId: string) {
    await this.stripeBilling.setCancelAtPeriodEnd(tenantId, false);
    await this.audit(tenantId, 'platform.billing.cancel_reverted', tenantId, {});
    return { ok: true };
  }

  async portalLink(tenantId: string) {
    const result = await this.stripeBilling.createPortalSession(tenantId);
    await this.audit(tenantId, 'platform.billing.portal_link_issued', tenantId, {});
    return result;
  }

  private audit(
    tenantId: string,
    action: string,
    target: string,
    metadata: Record<string, unknown>,
  ) {
    return this.tenantCtx.runWithTenantBypass(() =>
      this.prisma.auditLog.create({
        data: { tenantId, action, target, metadata: metadata as Prisma.InputJsonValue },
      }),
    );
  }
}
