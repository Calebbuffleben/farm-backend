import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  MembershipRole,
  PendingCheckoutStatus,
  Plan,
  SubscriptionStatus,
  TenantStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import Stripe from 'stripe';

import { ARGON2_OPTIONS } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { assertPublicPriceIds } from './billing-env';
import {
  isDowngrade,
  isPublicPlan,
  isUpgrade,
  planToMaxUsers,
} from './plan-limits';
import { SeatCapacityService } from './seat-capacity.service';
import {
  itemIdOf,
  mappedSubscriptionFields,
  planToPriceId,
  type StripeSubLike,
} from './stripe-billing.mapper';
import type { CreateCheckoutSessionDto } from './dto/billing.dto';

const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class StripeBillingService {
  private readonly logger = new Logger(StripeBillingService.name);
  /** Overridable in tests. */
  stripeClient: Stripe | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly seats: SeatCapacityService,
  ) {}

  private stripe(): Stripe {
    if (this.stripeClient) return this.stripeClient;
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    if (!key) {
      throw new ServiceUnavailableException('Stripe is not configured');
    }
    this.stripeClient = new Stripe(key);
    return this.stripeClient;
  }

  private requirePublicPrice(plan: Plan): string {
    if (!isPublicPlan(plan)) {
      throw new BadRequestException(
        'Enterprise is contracted with sales — Starter, Growth and Scale can be purchased here',
      );
    }
    try {
      assertPublicPriceIds();
      return planToPriceId(plan);
    } catch (err) {
      throw new ServiceUnavailableException(
        err instanceof Error ? err.message : 'Stripe price IDs are not configured',
      );
    }
  }

  async createCheckoutSession(dto: CreateCheckoutSessionDto): Promise<{
    checkoutUrl: string;
  }> {
    const priceId = this.requirePublicPrice(dto.plan);
    const email = dto.email.trim().toLowerCase();
    const tenantSlug = dto.tenantSlug.trim().toLowerCase();
    const tenantName = dto.tenantName.trim();
    if (!tenantSlug || !tenantName) {
      throw new BadRequestException('tenantName and tenantSlug are required');
    }

    return this.tenantCtx.runWithTenantBypass(async () => {
      const existingTenant = await this.prisma.tenant.findUnique({
        where: { slug: tenantSlug },
      });
      if (existingTenant) {
        throw new ConflictException('Tenant slug already taken');
      }

      const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);
      const pending = await this.prisma.pendingCheckout.create({
        data: {
          email,
          passwordHash,
          name: dto.name?.trim() || null,
          tenantName,
          tenantSlug,
          plan: dto.plan,
          status: PendingCheckoutStatus.PENDING,
          expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
        },
      });

      const session = await this.stripe().checkout.sessions.create({
        mode: 'subscription',
        customer_email: email,
        client_reference_id: pending.id,
        payment_method_types: ['card'],
        allow_promotion_codes: true,
        locale: 'pt-BR',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: checkoutSuccessUrl(),
        cancel_url: requiredEnv('BILLING_CANCEL_URL'),
        metadata: {
          pendingCheckoutId: pending.id,
          plan: dto.plan,
          tenantSlug,
          kind: 'new_tenant',
        },
        subscription_data: {
          metadata: { pendingCheckoutId: pending.id, plan: dto.plan, kind: 'new_tenant' },
        },
      });

      if (!session.url) {
        throw new ServiceUnavailableException('Stripe did not return a checkout URL');
      }

      await this.prisma.pendingCheckout.update({
        where: { id: pending.id },
        data: { stripeCheckoutSessionId: session.id },
      });

      return { checkoutUrl: session.url };
    });
  }

  /**
   * Existing tenant: subscribe (no Stripe customer) or change public plan.
   * Upgrades take effect immediately with proration. Downgrades are scheduled
   * for the next cycle and keep the current seat cap until then.
   */
  async changePaidPlan(
    tenantId: string,
    userId: string,
    plan: Plan,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ checkoutUrl: string } | { scheduled: true; plan: Plan } | Awaited<ReturnType<SeatCapacityService['snapshot']>>> {
    const priceId = this.requirePublicPrice(plan);
    return this.tenantCtx.runWithTenantBypass(async () => {
      const sub = await this.prisma.subscription.findUnique({ where: { tenantId } });
      if (!sub) throw new NotFoundException('Subscription not found for tenant');
      if (sub.plan === Plan.ENTERPRISE && plan !== Plan.ENTERPRISE) {
        throw new BadRequestException(
          'Enterprise changes are handled by the sales team',
        );
      }

      const newMax = planToMaxUsers(plan);
      if (isDowngrade(sub.plan, plan) || (!isUpgrade(sub.plan, plan) && newMax < sub.maxUsers)) {
        await this.seats.assertFitsMaxUsers(tenantId, newMax);
      }

      if (!sub.stripeSubscriptionId) {
        const checkoutUrl = await this.createExistingTenantCheckout(tenantId, plan, priceId);
        await this.prisma.auditLog.create({
          data: {
            tenantId,
            userId,
            action: 'billing.checkout.existing_started',
            target: tenantId,
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: { plan },
          },
        });
        return { checkoutUrl };
      }

      const remote = (await this.stripe().subscriptions.retrieve(
        sub.stripeSubscriptionId,
      )) as StripeSubLike;
      const itemId = itemIdOf(remote);
      if (!itemId) {
        throw new ServiceUnavailableException('Stripe subscription has no items');
      }

      if (isUpgrade(sub.plan, plan) || sub.plan === plan) {
        await this.stripe().subscriptions.update(sub.stripeSubscriptionId, {
          items: [{ id: itemId, price: priceId }],
          proration_behavior: 'create_prorations',
        });
        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: {
            plan,
            maxUsers: newMax,
            stripePriceId: priceId,
            pendingPlan: null,
            pendingMaxUsers: null,
            seatLimitHoldReason: null,
            status: SubscriptionStatus.ACTIVE,
          },
        });
        await this.prisma.auditLog.create({
          data: {
            tenantId,
            userId,
            action: 'billing.plan_upgraded',
            target: sub.id,
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: { from: sub.plan, to: plan },
          },
        });
        return this.seats.snapshot(tenantId);
      }

      await this.stripe().subscriptions.update(sub.stripeSubscriptionId, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: 'none',
      });
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: {
          pendingPlan: plan,
          pendingMaxUsers: newMax,
          stripePriceId: priceId,
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          userId,
          action: 'billing.plan_downgrade_scheduled',
          target: sub.id,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: { from: sub.plan, to: plan, at: sub.currentPeriodEnd },
        },
      });
      return { scheduled: true as const, plan };
    });
  }

  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw new ServiceUnavailableException('STRIPE_WEBHOOK_SECRET is not configured');
    }
    if (!rawBody || !signature) {
      throw new BadRequestException('Missing Stripe payload or signature');
    }
    let event: Stripe.Event;
    try {
      event = this.stripe().webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Stripe signature verification failed: ${msg}`);
    }
    await this.handleWebhookEvent(event);
    return { received: true };
  }

  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        await this.provisionFromCheckout(event.data.object as Stripe.Checkout.Session, event.id);
        return;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.applyAndAudit(
          event.data.object as StripeSubLike,
          event.id,
          `billing.webhook.${event.type.replace(/\./g, '_')}`,
        );
        return;
      case 'customer.subscription.deleted':
        await this.applyAndAudit(
          { ...(event.data.object as StripeSubLike), status: 'canceled' },
          event.id,
          'billing.webhook.subscription_deleted',
        );
        return;
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoiceSubscriptionId(invoice);
        if (!subId) return;
        const remote = (await this.stripe().subscriptions.retrieve(subId)) as StripeSubLike;
        await this.applyAndAudit(remote, event.id, 'billing.webhook.invoice_paid');
        return;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoiceSubscriptionId(invoice);
        if (!subId) return;
        const local = await this.prisma.subscription.findUnique({
          where: { stripeSubscriptionId: subId },
        });
        if (!local) return;
        await this.applyAndAudit(
          {
            id: subId,
            customer: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id,
            status: 'past_due',
            cancel_at_period_end: local.cancelAtPeriodEnd,
          },
          event.id,
          'billing.webhook.payment_failed',
        );
        return;
      }
      default:
        return;
    }
  }

  async applySubscriptionState(stripeSub: StripeSubLike) {
    const fields = mappedSubscriptionFields(stripeSub);
    return this.tenantCtx.runWithTenantBypass(async () => {
      const existing = await this.prisma.subscription.findUnique({
        where: { stripeSubscriptionId: fields.stripeSubscriptionId },
      });
      if (!existing) {
        return null;
      }

      const nextPlan = fields.plan ?? existing.plan;
      const nextMax = fields.maxUsers ?? existing.maxUsers;
      const used =
        (await this.prisma.membership.count({ where: { tenantId: existing.tenantId } })) +
        (await this.prisma.invitation.count({
          where: { tenantId: existing.tenantId, status: 'PENDING' },
        }));

      const loweringSeats = nextMax < existing.maxUsers;
      const periodStillOpen =
        Boolean(existing.currentPeriodEnd && existing.currentPeriodEnd.getTime() > Date.now()) ||
        Boolean(fields.currentPeriodEnd && fields.currentPeriodEnd.getTime() > Date.now());

      if (loweringSeats && used > nextMax) {
        this.logger.warn(
          `Seat-limit hold for tenant ${existing.tenantId}: used ${used} > ${nextMax}`,
        );
        return this.prisma.subscription.update({
          where: { id: existing.id },
          data: {
            status: fields.status,
            stripeCustomerId: fields.stripeCustomerId ?? existing.stripeCustomerId,
            stripePriceId: fields.stripePriceId ?? existing.stripePriceId,
            currentPeriodEnd: fields.currentPeriodEnd ?? existing.currentPeriodEnd,
            cancelAtPeriodEnd: fields.cancelAtPeriodEnd,
            pendingPlan: nextPlan,
            pendingMaxUsers: nextMax,
            seatLimitHoldReason: `Stripe attempted to set maxUsers=${nextMax} with ${used} seats in use`,
          },
        });
      }

      if (loweringSeats && periodStillOpen) {
        return this.prisma.subscription.update({
          where: { id: existing.id },
          data: {
            status: fields.status,
            stripeCustomerId: fields.stripeCustomerId ?? existing.stripeCustomerId,
            stripePriceId: fields.stripePriceId ?? existing.stripePriceId,
            currentPeriodEnd: fields.currentPeriodEnd ?? existing.currentPeriodEnd,
            cancelAtPeriodEnd: fields.cancelAtPeriodEnd,
            pendingPlan: nextPlan,
            pendingMaxUsers: nextMax,
          },
        });
      }

      return this.prisma.subscription.update({
        where: { id: existing.id },
        data: {
          status: fields.status,
          ...(fields.plan ? { plan: fields.plan, maxUsers: fields.maxUsers } : {}),
          stripeCustomerId: fields.stripeCustomerId ?? existing.stripeCustomerId,
          stripePriceId: fields.stripePriceId,
          currentPeriodEnd: fields.currentPeriodEnd,
          cancelAtPeriodEnd: fields.cancelAtPeriodEnd,
          pendingPlan: loweringSeats ? null : existing.pendingPlan,
          pendingMaxUsers: loweringSeats ? null : existing.pendingMaxUsers,
          seatLimitHoldReason: loweringSeats ? null : existing.seatLimitHoldReason,
        },
      });
    });
  }

  async checkoutSuccess(sessionId: string): Promise<{
    email: string;
    tenantSlug: string;
    plan: Plan;
  }> {
    const session = await this.stripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      throw new HttpException(
        'Checkout session is not paid',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return this.tenantCtx.runWithTenantBypass(async () => {
      const pending = await this.prisma.pendingCheckout.findUnique({
        where: { stripeCheckoutSessionId: sessionId },
      });
      if (pending) {
        return {
          email: pending.email,
          tenantSlug: pending.tenantSlug,
          plan: pending.plan,
        };
      }
      const tenantId = session.metadata?.tenantId;
      if (tenantId) {
        const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) throw new NotFoundException('Tenant not found for checkout');
        const sub = await this.prisma.subscription.findUnique({ where: { tenantId } });
        return {
          email: session.customer_email ?? session.customer_details?.email ?? '',
          tenantSlug: tenant.slug,
          plan: (session.metadata?.plan as Plan) || sub?.plan || Plan.STARTER,
        };
      }
      throw new NotFoundException('Checkout session unknown');
    });
  }

  async createPortalSession(tenantId: string): Promise<{ url: string }> {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const sub = await this.prisma.subscription.findUnique({
        where: { tenantId },
      });
      if (!sub?.stripeCustomerId) {
        throw new NotFoundException('No Stripe customer for this tenant');
      }
      const session = await this.stripe().billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: requiredEnv('BILLING_PORTAL_RETURN_URL'),
      });
      return { url: session.url };
    });
  }

  async syncFromStripe(tenantId: string): Promise<void> {
    const sub = await this.tenantCtx.runWithTenantBypass(() =>
      this.prisma.subscription.findUnique({ where: { tenantId } }),
    );
    if (!sub?.stripeSubscriptionId) {
      throw new ConflictException('Tenant is not Stripe-linked');
    }
    const remote = await this.stripe().subscriptions.retrieve(sub.stripeSubscriptionId);
    await this.applySubscriptionState(remote as StripeSubLike);
  }

  async setCancelAtPeriodEnd(tenantId: string, cancel: boolean): Promise<void> {
    const sub = await this.tenantCtx.runWithTenantBypass(() =>
      this.prisma.subscription.findUnique({ where: { tenantId } }),
    );
    if (!sub?.stripeSubscriptionId) {
      throw new ConflictException('Tenant is not Stripe-linked');
    }
    await this.stripe().subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: cancel,
    });
  }

  private async createExistingTenantCheckout(
    tenantId: string,
    plan: Plan,
    priceId: string,
  ): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant not found');
    const owner = await this.prisma.membership.findFirst({
      where: { tenantId, role: MembershipRole.OWNER },
      include: { user: { select: { email: true } } },
    });
    const sub = await this.prisma.subscription.findUnique({ where: { tenantId } });
    const session = await this.stripe().checkout.sessions.create({
      mode: 'subscription',
      ...(sub?.stripeCustomerId
        ? { customer: sub.stripeCustomerId }
        : { customer_email: owner?.user.email }),
      client_reference_id: tenantId,
      payment_method_types: ['card'],
      allow_promotion_codes: true,
      locale: 'pt-BR',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: checkoutSuccessUrl(),
      cancel_url: requiredEnv('BILLING_CANCEL_URL'),
      metadata: { tenantId, plan, kind: 'existing_tenant' },
      subscription_data: {
        metadata: { tenantId, plan, kind: 'existing_tenant' },
      },
    });
    if (!session.url) {
      throw new ServiceUnavailableException('Stripe did not return a checkout URL');
    }
    return session.url;
  }

  private async applyAndAudit(
    stripeSub: StripeSubLike,
    eventId: string,
    action: string,
  ) {
    await this.tenantCtx.runWithTenantBypass(async () => {
      const existing = await this.prisma.subscription.findUnique({
        where: { stripeSubscriptionId: stripeSub.id },
      });
      const updated = await this.applySubscriptionState(stripeSub);
      if (!updated) return;
      await this.prisma.auditLog.create({
        data: {
          tenantId: updated.tenantId,
          action,
          target: updated.id,
          metadata: {
            eventId,
            fromStatus: existing?.status ?? null,
            toStatus: updated.status,
            fromPlan: existing?.plan ?? null,
            toPlan: updated.plan,
            hold: updated.seatLimitHoldReason,
          },
        },
      });
    });
  }

  private async provisionFromCheckout(
    session: Stripe.Checkout.Session,
    eventId: string,
  ) {
    const sessionId = session.id;
    const kind = session.metadata?.kind;
    if (kind === 'existing_tenant' && session.metadata?.tenantId) {
      await this.attachExistingTenant(session, eventId);
      return;
    }
    await this.tenantCtx.runWithTenantBypass(async () => {
      const pending = await this.prisma.pendingCheckout.findUnique({
        where: { stripeCheckoutSessionId: sessionId },
      });
      if (!pending) {
        if (session.metadata?.tenantId) {
          await this.attachExistingTenant(session, eventId);
          return;
        }
        this.logger.warn(`checkout.session.completed with unknown session ${sessionId}`);
        return;
      }
      if (pending.status === PendingCheckoutStatus.COMPLETED) {
        return;
      }

      const stripeSubId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;
      const stripeCustomerId =
        typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id ?? null;

      let stripeSub: StripeSubLike | null = null;
      if (stripeSubId) {
        stripeSub = (await this.stripe().subscriptions.retrieve(
          stripeSubId,
        )) as StripeSubLike;
      }

      await this.prisma.$transaction(async (tx) => {
        const again = await tx.pendingCheckout.findUnique({
          where: { id: pending.id },
        });
        if (!again || again.status === PendingCheckoutStatus.COMPLETED) {
          return;
        }

        let user = await tx.user.findUnique({ where: { email: pending.email } });
        if (!user) {
          user = await tx.user.create({
            data: {
              email: pending.email,
              passwordHash: pending.passwordHash,
              name: pending.name,
              isActive: true,
            },
          });
        }

        let slug = pending.tenantSlug;
        let n = 2;
        while (await tx.tenant.findUnique({ where: { slug } })) {
          slug = `${pending.tenantSlug}-${n}`;
          n += 1;
        }

        const tenant = await tx.tenant.create({
          data: {
            slug,
            name: pending.tenantName,
            status: TenantStatus.ACTIVE,
          },
        });

        await tx.membership.create({
          data: {
            userId: user.id,
            tenantId: tenant.id,
            role: MembershipRole.OWNER,
          },
        });

        const mapped = stripeSub ? mappedSubscriptionFields(stripeSub) : null;
        await tx.subscription.create({
          data: {
            tenantId: tenant.id,
            plan: pending.plan,
            maxUsers: planToMaxUsers(pending.plan),
            status: SubscriptionStatus.ACTIVE,
            stripeCustomerId: mapped?.stripeCustomerId ?? stripeCustomerId,
            stripeSubscriptionId: mapped?.stripeSubscriptionId ?? stripeSubId ?? null,
            stripePriceId: mapped?.stripePriceId ?? null,
            currentPeriodEnd: mapped?.currentPeriodEnd ?? null,
            cancelAtPeriodEnd: mapped?.cancelAtPeriodEnd ?? false,
          },
        });

        await tx.pendingCheckout.update({
          where: { id: pending.id },
          data: {
            status: PendingCheckoutStatus.COMPLETED,
            tenantId: tenant.id,
            tenantSlug: slug,
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            action: 'billing.checkout.completed',
            target: tenant.id,
            metadata: { eventId, sessionId, plan: pending.plan },
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            action: 'billing.webhook.checkout_completed',
            target: tenant.id,
            metadata: { eventId, sessionId, plan: pending.plan },
          },
        });
      });
    });
  }

  private async attachExistingTenant(
    session: Stripe.Checkout.Session,
    eventId: string,
  ) {
    const tenantId = session.metadata?.tenantId;
    if (!tenantId) return;
    await this.tenantCtx.runWithTenantBypass(async () => {
      const existing = await this.prisma.subscription.findUnique({ where: { tenantId } });
      if (!existing) {
        this.logger.warn(`existing-tenant checkout with unknown tenant ${tenantId}`);
        return;
      }
      const stripeSubId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;
      const stripeCustomerId =
        typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id ?? null;
      let mapped = stripeSubId
        ? mappedSubscriptionFields(
            (await this.stripe().subscriptions.retrieve(stripeSubId)) as StripeSubLike,
          )
        : null;
      const plan = (session.metadata?.plan as Plan) || mapped?.plan || existing.plan;
      await this.prisma.subscription.update({
        where: { id: existing.id },
        data: {
          plan: isPublicPlan(plan) ? plan : existing.plan,
          maxUsers: isPublicPlan(plan) ? planToMaxUsers(plan) : existing.maxUsers,
          status: SubscriptionStatus.ACTIVE,
          stripeCustomerId: mapped?.stripeCustomerId ?? stripeCustomerId,
          stripeSubscriptionId: mapped?.stripeSubscriptionId ?? stripeSubId ?? existing.stripeSubscriptionId,
          stripePriceId: mapped?.stripePriceId ?? existing.stripePriceId,
          currentPeriodEnd: mapped?.currentPeriodEnd ?? existing.currentPeriodEnd,
          cancelAtPeriodEnd: mapped?.cancelAtPeriodEnd ?? false,
          pendingPlan: null,
          pendingMaxUsers: null,
          seatLimitHoldReason: null,
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          action: 'billing.checkout.existing_completed',
          target: existing.id,
          metadata: { eventId, sessionId: session.id, plan },
        },
      });
    });
  }
}

function checkoutSuccessUrl(): string {
  const successBase = requiredEnv('BILLING_SUCCESS_URL');
  return successBase.includes('?')
    ? `${successBase}&session_id={CHECKOUT_SESSION_ID}`
    : `${successBase}?session_id={CHECKOUT_SESSION_ID}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ServiceUnavailableException(`${name} is not configured`);
  }
  return value;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const raw = (invoice as Stripe.Invoice & {
    subscription?: string | { id?: string } | null;
  }).subscription;
  if (!raw) {
    const parent = (
      invoice as Stripe.Invoice & {
        parent?: { subscription_details?: { subscription?: string } } | null;
      }
    ).parent?.subscription_details?.subscription;
    return parent ?? null;
  }
  return typeof raw === 'string' ? raw : raw.id ?? null;
}
