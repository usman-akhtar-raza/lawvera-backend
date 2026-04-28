import {
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../common/enums/role.enum';

export class CreateManagedUserDto {
  @IsString()
  readonly name: string;

  @IsEmail()
  readonly email: string;

  @IsString()
  @MinLength(6)
  readonly password: string;

  @IsEnum(UserRole)
  readonly role: UserRole;

  @IsOptional()
  @IsString()
  readonly city?: string;

  @IsOptional()
  @IsString()
  readonly phone?: string;

  @IsOptional()
  @IsString()
  readonly specialization?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  readonly experienceYears?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  readonly consultationFee?: number;

  @IsOptional()
  @IsString()
  readonly education?: string;

  @IsOptional()
  @IsString()
  readonly description?: string;
}
