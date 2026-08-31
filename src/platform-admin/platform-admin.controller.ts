import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import {
  CreatePlatformInvitationDto,
  CreateTenantDto,
  InviteListQueryDto,
  TenantListQueryDto,
  UpdateTenantBillingDto,
  UpdateTenantDto,
  UserListQueryDto,
} from './dto/platform-admin.dto';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';

@Controller('platform-admin')
@Public()
@UseGuards(PlatformAdminGuard)
@SkipThrottle()
export class PlatformAdminController {
  constructor(private readonly admin: PlatformAdminService) {}

  @Get('tenants')
  listTenants(@Query() query: TenantListQueryDto) {
    return this.admin.listTenants(query);
  }

  @Post('tenants')
  createTenant(@Body() dto: CreateTenantDto) {
    return this.admin.createTenant(dto);
  }

  @Get('tenants/:id')
  getTenant(@Param('id') id: string) {
    return this.admin.getTenant(id);
  }

  @Patch('tenants/:id')
  updateTenant(@Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.admin.updateTenant(id, dto);
  }

  @Patch('tenants/:id/billing')
  updateTenantBilling(
    @Param('id') id: string,
    @Body() dto: UpdateTenantBillingDto,
  ) {
    return this.admin.updateTenantBilling(id, dto);
  }

  @Get('users')
  listUsers(@Query() query: UserListQueryDto) {
    return this.admin.listUsers(query);
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  @Get('invites')
  listInvites(@Query() query: InviteListQueryDto) {
    return this.admin.listInvites(query);
  }

  @Post('tenants/:tenantId/invites')
  createInvite(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreatePlatformInvitationDto,
  ) {
    return this.admin.createInvite(tenantId, dto);
  }

  @Delete('invites/:id')
  revokeInvite(@Param('id') id: string) {
    return this.admin.revokeInvite(id);
  }
}
