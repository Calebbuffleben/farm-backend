import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { InternalModule } from '../internal/internal.module';
import { OpsModule } from '../ops/ops.module';
import { WabaModule } from '../waba/waba.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Home das 5 perguntas + drill até a evidência.
 * Alertas Socket.IO ficam de fora no ano 1: o critério é o dono abrir 2x/semana,
 * não um floor ao vivo. Upgrade: gateway por tenant quando o volume pedir.
 */
@Module({
  imports: [PrismaModule, InternalModule, OpsModule, WabaModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
