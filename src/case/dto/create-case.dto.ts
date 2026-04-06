import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { CaseCategory } from '../../common/enums/case-category.enum';

export class CreateCaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description: string;

  @IsEnum(CaseCategory)
  category: CaseCategory;
}
