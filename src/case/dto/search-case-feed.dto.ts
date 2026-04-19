import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CaseCategory } from '../../common/enums/case-category.enum';

export class SearchCaseFeedDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsEnum(CaseCategory)
  category?: CaseCategory;
}
