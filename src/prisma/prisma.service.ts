import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { createTenancyMiddleware } from '../tenancy/prisma-tenancy.middleware';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(private readonly tenantContext: TenantContextService) {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'error', 'warn']
          : ['error'],
    });
  }

  async onModuleInit() {
    // Register the fail-closed tenancy middleware BEFORE opening the
    // connection so no query slips through during startup warm-up.
    this.$use(createTenancyMiddleware(this.tenantContext));
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/**
 * Declaration merge: ensures model delegates (e.g. `playbookTemplate`) appear on
 * `PrismaService` for TypeScript when extending `PrismaClient` — matches generated
 * `@prisma/client` after `prisma generate`.
 */
export interface PrismaService extends PrismaClient {}

// Type assertion to ensure TypeScript recognizes PrismaClient methods
export type PrismaServiceType = PrismaClient;
