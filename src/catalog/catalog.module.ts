import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChannelModule } from '../channel/channel.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/** Carteira (dimensões agro) + fila unknown de resolução em 1 toque. */
@Module({
  imports: [PrismaModule, ChannelModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
