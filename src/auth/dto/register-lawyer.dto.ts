import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

class AvailabilityDto {
  @IsString()
  day: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  slots: string[];
}

export class RegisterLawyerDto {
  @IsString()
  readonly name: string;

  @IsEmail()
  readonly email: string;

  @IsString()
  @MinLength(6)
  readonly password: string;

  @IsString()
  readonly specialization: string;

  @IsNumber()
  @Min(0)
  readonly experienceYears: number;

  @IsString()
  readonly city: string;

  @IsNumber()
  @Min(0)
  readonly consultationFee: number;

  @IsOptional()
  @IsString()
  readonly education?: string;

  @IsOptional()
  @IsString()
  readonly description?: string;

  @IsOptional()
  @IsString()
  readonly profilePhotoUrl?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => AvailabilityDto)
  readonly availability: AvailabilityDto[];
}

