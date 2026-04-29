import { IsString, MinLength } from 'class-validator';

export class CaptureCaseEscrowDto {
  @IsString()
  @MinLength(3)
  orderId: string;
}
