import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChannelModule } from '../channel/channel.module';
import { OpsModule } from '../ops/ops.module';
import { StorageModule } from '../waba/storage.module';
import { EmailClient } from './email.client';
import { EmailController } from './email.controller';
import { EmailSettingsController } from './email-settings.controller';

@Module({
  imports: [PrismaModule, ChannelModule, OpsModule, StorageModule],
  controllers: [EmailController, EmailSettingsController],
  providers: [EmailClient],
  exports: [EmailClient],
})
export class EmailModule {}
