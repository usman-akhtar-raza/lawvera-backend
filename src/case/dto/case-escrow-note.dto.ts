import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CaseEscrowNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
