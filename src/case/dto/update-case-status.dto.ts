import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CaseStatus } from '../../common/enums/case-status.enum';

export class UpdateCaseStatusDto {
  @IsEnum(CaseStatus)
  status: CaseStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
