import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { IsOptional, IsString } from 'class-validator';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { CatalogService } from './catalog.service';

const MAX_CSV_BYTES = 5 * 1024 * 1024;

class ResolveUnknownDto {
  /** Fazenda escolhida; omitir/null = descartar o item */
  @IsOptional()
  @IsString()
  farmId?: string | null;
}

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /** Import da carteira (CSV do Excel/ERP). Repetível — faz upsert. */
  @Post('import')
  @AdminOnly()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES } }))
  async importCarteira(
    @CurrentUser() user: TenantContext | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!file?.buffer?.length) {
      throw new BadRequestException('CSV é obrigatório (campo "file")');
    }
    return this.catalog.importCarteira(
      user.tenantId,
      file.buffer.toString('utf8'),
    );
  }

  @Get('producers')
  @SkipThrottle()
  async listProducers(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.catalog.listProducers(user.tenantId);
  }

  @Get('unknowns')
  @SkipThrottle()
  async listUnknowns(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.catalog.listUnknowns(user.tenantId);
  }

  @Post('unknowns/:id/resolve')
  async resolveUnknown(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') unknownId: string,
    @Body() dto: ResolveUnknownDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.catalog.resolveUnknown(
      user.tenantId,
      user.userId,
      unknownId,
      dto.farmId ?? null,
    );
  }
}
