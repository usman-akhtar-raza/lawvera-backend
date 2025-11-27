import { IsOptional, IsString } from 'class-validator';

export class ManageSpecializationDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}

