import { IsEnum } from 'class-validator';

export enum LawSourceStatusDto {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

export class UpdateLawSourceDto {
  @IsEnum(LawSourceStatusDto)
  status: LawSourceStatusDto;
}
