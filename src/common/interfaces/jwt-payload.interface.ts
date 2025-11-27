import { UserRole } from '../enums/role.enum';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

