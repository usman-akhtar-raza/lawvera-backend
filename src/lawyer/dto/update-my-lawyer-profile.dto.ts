import { IsNumber, Min } from 'class-validator';

export class UpdateMyLawyerProfileDto {
  @IsNumber()
  @Min(0)
  consultationFee: number;
}
