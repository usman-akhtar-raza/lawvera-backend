import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCaseRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}
