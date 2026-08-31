import { ConflictException } from '@nestjs/common';
import { Plan, SubscriptionStatus } from '@prisma/client';

import { PlatformAdminService } from './platform-admin.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

describe('PlatformAdminService.updateTenantBilling force guardrail', () => {
  const tenantCtx = {
    runWithTenantBypass: async <T>(fn: () => Promise<T>) => fn(),
  } as TenantContextService;

  it('returns 409 when stripe-linked without force', async () => {
    const prisma = {
      tenant: {
        findUnique: async () => ({
          id: 't1',
          subscription: {
            plan: Plan.PRO,
            status: SubscriptionStatus.ACTIVE,
            maxUsers: 10,
            stripeSubscriptionId: 'sub_1',
          },
        }),
      },
    } as any;
    const svc = new PlatformAdminService(prisma, tenantCtx);
    await expect(
      svc.updateTenantBilling('t1', { plan: Plan.ENTERPRISE }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows force edit on stripe-linked tenants', async () => {
    const prisma = {
      tenant: {
        findUnique: async () => ({
          id: 't1',
          subscription: {
            plan: Plan.PRO,
            status: SubscriptionStatus.ACTIVE,
            maxUsers: 10,
            stripeSubscriptionId: 'sub_1',
          },
        }),
      },
      membership: { count: async () => 1 },
      subscription: {
        update: async () => ({
          id: 's1',
          plan: Plan.ENTERPRISE,
          status: SubscriptionStatus.ACTIVE,
          maxUsers: 50,
        }),
      },
      auditLog: { create: async () => ({}) },
    } as any;
    prisma.tenant.findUnique = async ({ include }: any) => {
      if (include?._count) {
        return { id: 't1', subscription: { plan: Plan.ENTERPRISE } };
      }
      return {
        id: 't1',
        subscription: {
          plan: Plan.PRO,
          status: SubscriptionStatus.ACTIVE,
          maxUsers: 10,
          stripeSubscriptionId: 'sub_1',
        },
      };
    };
    const svc = new PlatformAdminService(prisma, tenantCtx);
    await expect(
      svc.updateTenantBilling('t1', { plan: Plan.ENTERPRISE, force: true }),
    ).resolves.toBeTruthy();
  });
});
