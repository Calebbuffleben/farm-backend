import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChannelModule } from '../channel/channel.module';
import { OpsModule } from '../ops/ops.module';
import { VoiceClient } from './voice.client';
import { VoiceController } from './voice.controller';
import { VoiceSettingsController } from './voice-settings.controller';

@Module({
  imports: [PrismaModule, ChannelModule, OpsModule],
  controllers: [VoiceController, VoiceSettingsController],
  providers: [VoiceClient],
  exports: [VoiceClient],
})
export class VoiceModule {}
