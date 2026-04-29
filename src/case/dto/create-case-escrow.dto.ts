import { IsIn, IsNumber, IsOptional, Matches, Max, Min } from 'class-validator';

export class CreateCaseEscrowDto {
  @IsNumber()
  @Min(1)
  @Max(100000000)
  amount: number;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsIn(['wallet', 'card'])
  checkoutMode?: 'wallet' | 'card';
}
