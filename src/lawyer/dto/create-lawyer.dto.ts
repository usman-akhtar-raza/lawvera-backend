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

class AvailabilityInput {
  @IsString()
  day: string;

  @IsArray()
  @IsString({ each: true })
  slots: string[];
}

export class CreateLawyerDto {
  @IsString()
  userId: string;

  @IsString()
  specialization: string;

  @IsNumber()
  @Min(0)
  experienceYears: number;

  @IsString()
  city: string;

  @IsNumber()
  @Min(0)
  consultationFee: number;

  @IsOptional()
  @IsString()
  education?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  profilePhotoUrl?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvailabilityInput)
  @ArrayMinSize(1)
  availability: AvailabilityInput[];
}

