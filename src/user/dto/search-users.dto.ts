import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dtos/pagination-query.dto';

export class SearchUsersDto extends PaginationQueryDto {
  @Transform(({ value }) => Number(value))
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(50)
  limit?: number = 50;

  @IsOptional()
  @IsString()
  search?: string;
}
