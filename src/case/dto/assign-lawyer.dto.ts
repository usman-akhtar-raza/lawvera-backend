import { IsNotEmpty, IsString } from 'class-validator';

export class AssignLawyerDto {
  @IsString()
  @IsNotEmpty()
  lawyerId: string;
}
