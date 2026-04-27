import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsString,
  ValidateNested,
} from 'class-validator';
import { HasAtLeastOneSlot } from '../../common/validators/has-at-least-one-slot.decorator';

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
  @HasAtLeastOneSlot({
    message: 'Select at least one availability slot in the week',
  })
  availability: AvailabilityItemDto[];
}
