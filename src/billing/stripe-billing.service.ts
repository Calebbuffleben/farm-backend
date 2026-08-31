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
import { planToMaxUsers } from './plan-limits';
import {
  mappedSubscriptionFields,
  planToPriceId,
  type StripeSubLike,
} from './stripe-billing.mapper';
import type { CreateCheckoutSessionDto } from './dto/billing.dto';

const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
const PAID_PLANS = new Set<Plan>([Plan.PRO, Plan.ENTERPRISE]);

@Injectable()
export class StripeBillingService {
  private readonly logger = new Logger(StripeBillingService.name);
  /** Overridable in tests. */
  stripeClient: Stripe | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
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

  async createCheckoutSession(dto: CreateCheckoutSessionDto): Promise<{
    checkoutUrl: string;
  }> {
    if (!PAID_PLANS.has(dto.plan)) {
      throw new BadRequestException('Only PRO and ENTERPRISE can be purchased');
    }
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

      const successBase = requiredEnv('BILLING_SUCCESS_URL');
      const cancelUrl = requiredEnv('BILLING_CANCEL_URL');
      const successUrl = successBase.includes('?')
        ? `${successBase}&session_id={CHECKOUT_SESSION_ID}`
        : `${successBase}?session_id={CHECKOUT_SESSION_ID}`;

      let priceId: string;
      try {
        priceId = planToPriceId(dto.plan);
      } catch {
        throw new ServiceUnavailableException('Stripe price IDs are not configured');
      }

      const session = await this.stripe().checkout.sessions.create({
        mode: 'subscription',
        customer_email: email,
        client_reference_id: pending.id,
        payment_method_types: ['card'],
        allow_promotion_codes: true,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          pendingCheckoutId: pending.id,
          plan: dto.plan,
          tenantSlug,
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
      case 'customer.subscription.updated':
        await this.applyAndAudit(
          event.data.object as StripeSubLike,
          event.id,
          'billing.webhook.subscription_updated',
        );
        return;
      case 'customer.subscription.deleted':
        await this.applyAndAudit(
          { ...(event.data.object as StripeSubLike), status: 'canceled' },
          event.id,
          'billing.webhook.subscription_deleted',
        );
        return;
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
      return this.prisma.subscription.update({
        where: { id: existing.id },
        data: {
          status: fields.status,
          ...(fields.plan ? { plan: fields.plan, maxUsers: fields.maxUsers } : {}),
          stripeCustomerId: fields.stripeCustomerId,
          stripePriceId: fields.stripePriceId,
          currentPeriodEnd: fields.currentPeriodEnd,
          cancelAtPeriodEnd: fields.cancelAtPeriodEnd,
        },
      });
    });
  }

  async checkoutSuccess(sessionId: string): Promise<{
    email: string;
    tenantSlug: string;
    plan: Plan;
    downloads: { mac: string; win: string };
  }> {
    const session = await this.stripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      throw new HttpException(
        'Checkout session is not paid',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return this.tenantCtx.runWithTenantBypass(async () => {
      const pending = await this.prisma.pendingCheckout.findUnique({
        where: { stripeCheckoutSessionId: sessionId },
      });
      if (!pending) {
        throw new NotFoundException('Checkout session unknown');
      }
      return {
        email: pending.email,
        tenantSlug: pending.tenantSlug,
        plan: pending.plan,
        downloads: {
          mac: process.env.DESKTOP_DOWNLOAD_MAC_URL?.trim() || '',
          win: process.env.DESKTOP_DOWNLOAD_WIN_URL?.trim() || '',
        },
      };
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
    await this.tenantCtx.runWithTenantBypass(async () => {
      const pending = await this.prisma.pendingCheckout.findUnique({
        where: { stripeCheckoutSessionId: sessionId },
      });
      if (!pending) {
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
  if (!raw) return null;
  return typeof raw === 'string' ? raw : raw.id ?? null;
}

