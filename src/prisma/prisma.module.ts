import { Module, Global } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenancyModule } from '../tenancy/tenancy.module';

@Global()
@Module({
  imports: [TenancyModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
