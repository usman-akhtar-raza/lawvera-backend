import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

class AvailabilitySlotDto {
  @IsString()
  day: string;

  @IsArray()
  @IsString({ each: true })
  slots: string[];
}

export class ApplyAsLawyerDto {
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
  @ArrayMinSize(0)
  @Type(() => AvailabilitySlotDto)
  readonly availability: AvailabilitySlotDto[];
}
