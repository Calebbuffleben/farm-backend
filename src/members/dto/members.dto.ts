import { MembershipRole } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateMemberRoleDto {
  @IsEnum(MembershipRole)
  role!: MembershipRole;
}
