import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UploadLawSourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  edition?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  jurisdiction?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  language?: string;
}
