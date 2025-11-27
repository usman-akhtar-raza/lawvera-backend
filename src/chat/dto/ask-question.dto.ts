import { IsOptional, IsString } from 'class-validator';

export class AskQuestionDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  sessionId?: string;
}

