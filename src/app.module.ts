import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { MembersModule } from './members/members.module';
import { InvitationsModule } from './invitations/invitations.module';
import { PlatformAdminModule } from './platform-admin/platform-admin.module';
import { WabaModule } from './waba/waba.module';
import { VoiceModule } from './voice/voice.module';
import { EmailModule } from './email/email.module';
import { CatalogModule } from './catalog/catalog.module';
import { InternalModule } from './internal/internal.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { OpsModule } from './ops/ops.module';
import { ConsentModule } from './consent/consent.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 120 },
    ]),
    TenancyModule,
    PrismaModule,
    AuthModule,
    BillingModule,
    MembersModule,
    InvitationsModule,
    PlatformAdminModule,
    WabaModule,
    VoiceModule,
    EmailModule,
    CatalogModule,
    InternalModule,
    DashboardModule,
    OpsModule,
    ConsentModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
