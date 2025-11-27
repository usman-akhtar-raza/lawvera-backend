import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsString,
  ValidateNested,
} from 'class-validator';

class AvailabilityItemDto {
  @IsString()
  day: string;

  @IsArray()
  @IsString({ each: true })
  slots: string[];
}

export class UpdateAvailabilityDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvailabilityItemDto)
  @ArrayMinSize(1)
  availability: AvailabilityItemDto[];
}

