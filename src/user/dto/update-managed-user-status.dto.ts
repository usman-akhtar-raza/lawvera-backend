import { IsBoolean } from 'class-validator';

export class UpdateManagedUserStatusDto {
  @IsBoolean()
  isActive: boolean;
}
