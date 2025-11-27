import { IsEnum, IsOptional, IsString } from 'class-validator';
import { BookingStatus } from '../../common/enums/booking-status.enum';

export class UpdateBookingStatusDto {
  @IsEnum(BookingStatus)
  status: BookingStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}

