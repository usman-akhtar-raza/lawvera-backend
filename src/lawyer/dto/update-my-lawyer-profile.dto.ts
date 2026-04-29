import { IsEmail, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateMyLawyerProfileDto {
  @IsNumber()
  @Min(0)
  consultationFee: number;

  @IsOptional()
  @IsEmail()
  paypalEmail?: string;
}
