import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserController } from '../../user/user.controller';
import { RolesGuard } from './roles.guard';
import { UserRole } from '../enums/role.enum';

const createContext = (role?: UserRole) =>
  ({
    getHandler: () => UserController.prototype.findAll,
    getClass: () => UserController,
    switchToHttp: () => ({
      getRequest: () => ({
        user: role ? { role } : undefined,
      }),
    }),
  }) as unknown as ExecutionContext;

describe('RBAC guard for users list', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows ADMIN role to access users list', () => {
    const context = createContext(UserRole.ADMIN);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('blocks non-admin role from users list', () => {
    const context = createContext(UserRole.CLIENT);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
