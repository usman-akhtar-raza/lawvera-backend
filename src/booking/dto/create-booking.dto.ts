import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { BookingStatus } from '../../common/enums/booking-status.enum';

export class CreateBookingDto {
  @IsString()
  lawyerId: string;

  @IsDateString()
  slotDate: string;

  @IsString()
  slotTime: string;

  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus = BookingStatus.PENDING;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

