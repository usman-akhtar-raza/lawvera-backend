import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, Min } from 'class-validator';

export class PaginationQueryDto {
  @Transform(({ value }) => Number(value))
  @IsNumber()
  @IsOptional()
  @Min(1)
  page?: number = 1;

  @Transform(({ value }) => Number(value))
  @IsNumber()
  @IsOptional()
  @Min(1)
  limit?: number = 20;
}

