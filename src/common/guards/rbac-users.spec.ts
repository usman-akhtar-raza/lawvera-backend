import {
  type ContextType,
  type ExecutionContext,
  ForbiddenException,
  type Type,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserController } from '../../user/user.controller';
import { RolesGuard } from './roles.guard';
import { UserRole } from '../enums/role.enum';

const userListHandlerDescriptor = Object.getOwnPropertyDescriptor(
  UserController.prototype,
  'findAll',
) as TypedPropertyDescriptor<UserController['findAll']> | undefined;

const userListHandler = userListHandlerDescriptor?.value;

if (!userListHandler) {
  throw new Error(
    'UserController.findAll handler is unavailable for the RBAC test.',
  );
}

const createContext = (role?: UserRole): ExecutionContext => {
  const request = {
    user: role ? { role } : undefined,
  };
  const args = [request];
  const httpHost: ReturnType<ExecutionContext['switchToHttp']> = {
    getRequest: <T = typeof request>() => request as T,
    getResponse: <T = unknown>() => ({}) as T,
    getNext: <T = unknown>() => ({}) as T,
  };
  const rpcHost: ReturnType<ExecutionContext['switchToRpc']> = {
    getData: <T = unknown>() => ({}) as T,
    getContext: <T = unknown>() => ({}) as T,
  };
  const wsHost: ReturnType<ExecutionContext['switchToWs']> = {
    getData: <T = unknown>() => ({}) as T,
    getClient: <T = unknown>() => ({}) as T,
    getPattern: () => 'users.findAll',
  };

  return {
    getHandler: () => userListHandler,
    getClass: <T = UserController>(): Type<T> =>
      UserController as unknown as Type<T>,
    getArgs: <T extends unknown[] = unknown[]>() => args as T,
    getArgByIndex: <T = unknown>(index: number) => args[index] as T,
    switchToHttp: () => httpHost,
    switchToRpc: () => rpcHost,
    switchToWs: () => wsHost,
    getType: <TContext extends string = ContextType>() => 'http' as TContext,
  };
};

describe('RBAC guard for users list', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows ADMIN role to access users list', () => {
    const context = createContext(UserRole.ADMIN);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows SUPER_ADMIN role to access admin-protected users list', () => {
    const context = createContext(UserRole.SUPER_ADMIN);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('blocks non-admin role from users list', () => {
    const context = createContext(UserRole.CLIENT);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
