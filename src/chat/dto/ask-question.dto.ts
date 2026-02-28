import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class AskQuestionDto {
  @IsString()
  @MaxLength(4000)
  message: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsIn(['user', 'lawyer'])
  mode?: 'user' | 'lawyer';

  @IsOptional()
  @IsString()
  jurisdiction?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceIds?: string[];
}
