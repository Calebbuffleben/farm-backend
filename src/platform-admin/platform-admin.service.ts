import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InviteStatus,
  MembershipRole,
  Plan,
  Prisma,
  SubscriptionStatus,
  TenantStatus,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { planToMaxUsers } from '../billing/plan-limits';
import {
  CreatePlatformInvitationDto,
  CreateTenantDto,
  InviteListQueryDto,
  TenantListQueryDto,
  UpdateTenantBillingDto,
  UpdateTenantDto,
  UserListQueryDto,
} from './dto/platform-admin.dto';

const DEFAULT_LIMIT = 25;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  listTenants(query: TenantListQueryDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const { skip, take } = page(query.page, query.limit);
      const where: Prisma.TenantWhereInput = {
        status: query.status,
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { slug: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const [total, items] = await Promise.all([
        this.prisma.tenant.count({ where }),
        this.prisma.tenant.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          include: {
            subscription: true,
            _count: {
              select: {
                memberships: true,
                invitations: true,
              },
            },
          },
        }),
      ]);
      return { total, items };
    });
  }

  getTenant(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id },
        include: {
          subscription: true,
          memberships: {
            include: { user: { select: { id: true, email: true, name: true } } },
            orderBy: { createdAt: 'asc' },
          },
          invitations: { orderBy: { createdAt: 'desc' }, take: 50 },
          _count: {
            select: { memberships: true, invitations: true },
          },
        },
      });
      if (!tenant) throw new NotFoundException('Tenant not found');
      return tenant;
    });
  }

  createTenant(dto: CreateTenantDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const name = dto.name.trim();
      const slug = normalizeTenantSlug(dto.slug ?? name);
      if (!slug) {
        throw new BadRequestException('Invalid tenant slug');
      }
      const existing = await this.prisma.tenant.findUnique({ where: { slug } });
      if (existing) {
        throw new BadRequestException('Tenant slug already taken');
      }
      const plan = dto.plan ?? Plan.FREE;
      const tenant = await this.prisma.tenant.create({
        data: {
          slug,
          name,
          status: TenantStatus.ACTIVE,
          subscription: {
            create: {
              plan,
              maxUsers: planToMaxUsers(plan),
              status: SubscriptionStatus.ACTIVE,
            },
          },
        },
        include: {
          subscription: true,
          _count: {
            select: {
              memberships: true,
              invitations: true,
            },
          },
        },
      });
      const ownerBootstrap = await this.bootstrapOwner(tenant.id, dto.ownerEmail);

      await this.prisma.auditLog.create({
        data: {
          tenantId: tenant.id,
          action: 'platform.tenant.created',
          target: tenant.id,
          metadata: {
            slug,
            plan,
            ownerEmail: ownerBootstrap.email,
            ownerBootstrap: ownerBootstrap.mode,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return { ...tenant, ownerBootstrap };
    });
  }

  private async bootstrapOwner(tenantId: string, ownerEmail: string) {
    const email = ownerEmail.trim().toLowerCase();
    if (!email.includes('@')) {
      throw new BadRequestException('Invalid owner email');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      const existingMembership = await this.prisma.membership.findUnique({
        where: {
          userId_tenantId: { userId: existingUser.id, tenantId },
        },
      });
      if (existingMembership) {
        throw new ConflictException(
          'Owner email is already a member of this tenant',
        );
      }
      const membership = await this.prisma.membership.create({
        data: {
          userId: existingUser.id,
          tenantId,
          role: MembershipRole.OWNER,
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          userId: existingUser.id,
          action: 'platform.tenant.owner_assigned',
          target: membership.id,
          metadata: { email, role: MembershipRole.OWNER },
        },
      });
      return {
        mode: 'membership' as const,
        email,
        membershipId: membership.id,
      };
    }

    const pendingInvite = await this.prisma.invitation.findFirst({
      where: { tenantId, email, status: InviteStatus.PENDING },
    });
    if (pendingInvite) {
      throw new ConflictException(
        'A pending invitation already exists for this owner email',
      );
    }

    const token = randomBytes(32).toString('base64url');
    const invite = await this.prisma.invitation.create({
      data: {
        tenantId,
        email,
        role: MembershipRole.OWNER,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        invitedById: null,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        action: 'platform.tenant.owner_invited',
        target: invite.id,
        metadata: { email, role: MembershipRole.OWNER },
      },
    });
    return {
      mode: 'invitation' as const,
      email,
      invitationId: invite.id,
      inviteToken: token,
    };
  }

  updateTenant(id: string, dto: UpdateTenantDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const tenant = await this.prisma.tenant.update({
        where: { id },
        data: {
          ...(dto.status ? { status: dto.status } : {}),
          ...(dto.name ? { name: dto.name.trim() } : {}),
        },
        include: {
          subscription: true,
          _count: {
            select: {
              memberships: true,
              invitations: true,
            },
          },
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId: id,
          action: 'platform.tenant.updated',
          target: id,
          metadata: dto as unknown as Prisma.InputJsonValue,
        },
      });
      return tenant;
    });
  }

  updateTenantBilling(id: string, dto: UpdateTenantBillingDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id },
        include: { subscription: true },
      });
      if (!tenant) throw new NotFoundException('Tenant not found');
      if (!tenant.subscription) {
        throw new NotFoundException('Subscription not found for tenant');
      }
      if (tenant.subscription.stripeSubscriptionId && dto.force !== true) {
        throw new ConflictException(
          'Tenant é gerenciado pelo Stripe — o webhook vai sobrescrever esta edição. Use sync/cancel, ou repita com force:true.',
        );
      }

      const nextPlan = dto.plan ?? tenant.subscription.plan;
      const planMax = planToMaxUsers(nextPlan);
      const nextMaxUsers = dto.plan
        ? (dto.maxUsers ?? planMax)
        : (dto.maxUsers ?? tenant.subscription.maxUsers);
      if (nextMaxUsers < planMax) {
        throw new BadRequestException(
          `maxUsers cannot be below plan default (${planMax})`,
        );
      }

      const memberCount = await this.prisma.membership.count({
        where: { tenantId: id },
      });
      if (memberCount > nextMaxUsers) {
        throw new BadRequestException(
          `Cannot set maxUsers to ${nextMaxUsers}: ${memberCount} members already enrolled`,
        );
      }

      const updated = await this.prisma.subscription.update({
        where: { tenantId: id },
        data: {
          ...(dto.plan ? { plan: dto.plan, maxUsers: nextMaxUsers } : {}),
          ...(!dto.plan && dto.maxUsers ? { maxUsers: nextMaxUsers } : {}),
          ...(dto.subscriptionStatus
            ? { status: dto.subscriptionStatus }
            : {}),
        },
      });

      await this.prisma.auditLog.create({
        data: {
          tenantId: id,
          action: 'platform.tenant.billing_updated',
          target: updated.id,
          metadata: {
            from: {
              plan: tenant.subscription.plan,
              status: tenant.subscription.status,
              maxUsers: tenant.subscription.maxUsers,
            },
            to: {
              plan: updated.plan,
              status: updated.status,
              maxUsers: updated.maxUsers,
            },
            forced: dto.force === true,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return this.prisma.tenant.findUnique({
        where: { id },
        include: {
          subscription: true,
          _count: {
            select: {
              memberships: true,
              invitations: true,
            },
          },
        },
      });
    });
  }

  listUsers(query: UserListQueryDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const { skip, take } = page(query.page, query.limit);
      const where: Prisma.UserWhereInput = {
        ...(query.q
          ? {
              OR: [
                { email: { contains: query.q, mode: 'insensitive' } },
                { name: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(query.tenantId || query.role
          ? {
              memberships: {
                some: {
                  ...(query.tenantId ? { tenantId: query.tenantId } : {}),
                  ...(query.role ? { role: query.role } : {}),
                },
              },
            }
          : {}),
      };
      const [total, items] = await Promise.all([
        this.prisma.user.count({ where }),
        this.prisma.user.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            name: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
            memberships: {
              include: { tenant: { select: { id: true, slug: true, name: true } } },
            },
          },
        }),
      ]);
      return { total, items };
    });
  }

  getUser(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const user = await this.prisma.user.findUnique({
        where: { id },
        include: {
          memberships: {
            include: { tenant: { select: { id: true, slug: true, name: true, status: true } } },
          },
        },
      });
      if (!user) throw new NotFoundException('User not found');
      return user;
    });
  }

  listInvites(query: InviteListQueryDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const { skip, take } = page(query.page, query.limit);
      const where: Prisma.InvitationWhereInput = {
        tenantId: query.tenantId,
        status: query.status,
        ...(query.q
          ? { email: { contains: query.q, mode: 'insensitive' } }
          : {}),
      };
      const [total, items] = await Promise.all([
        this.prisma.invitation.count({ where }),
        this.prisma.invitation.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          include: {
            tenant: { select: { id: true, slug: true, name: true } },
            invitedBy: { select: { id: true, email: true, name: true } },
          },
        }),
      ]);
      return { total, items };
    });
  }

  createInvite(tenantId: string, dto: CreatePlatformInvitationDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const normalizedEmail = dto.email.trim().toLowerCase();
      if (!normalizedEmail.includes('@')) {
        throw new BadRequestException('Invalid email');
      }
      const inviter = await this.prisma.membership.findFirst({
        where: { tenantId, role: { in: [MembershipRole.OWNER, MembershipRole.ADMIN] } },
        orderBy: { createdAt: 'asc' },
      });
      if (!inviter) {
        throw new NotFoundException('Tenant has no admin member to own invite');
      }
      const token = randomBytes(32).toString('base64url');
      const invite = await this.prisma.invitation.create({
        data: {
          tenantId,
          email: normalizedEmail,
          role: dto.role ?? MembershipRole.MEMBER,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          invitedById: inviter.userId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          action: 'platform.invite.created',
          target: invite.id,
          metadata: { email: normalizedEmail, role: invite.role },
        },
      });
      return { ...invite, token };
    });
  }

  revokeInvite(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const invite = await this.prisma.invitation.update({
        where: { id },
        data: { status: InviteStatus.REVOKED, revokedAt: new Date() },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId: invite.tenantId,
          action: 'platform.invite.revoked',
          target: invite.id,
        },
      });
      return invite;
    });
  }
}

function page(pageNumber = 1, limit = DEFAULT_LIMIT) {
  const take = Math.min(Math.max(limit, 1), 200);
  const current = Math.max(pageNumber, 1);
  return { skip: (current - 1) * take, take };
}

function normalizeTenantSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
