import { UserRole } from '../enums/role.enum';

export const isAdminRole = (role?: UserRole | null): boolean =>
  role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
