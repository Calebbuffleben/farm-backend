import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MembersService } from './members.service';
import { MembersController } from './members.controller';

@Module({
  imports: [PrismaModule, TenancyModule],
  providers: [MembersService],
  controllers: [MembersController],
  exports: [MembersService],
})
export class MembersModule {}
