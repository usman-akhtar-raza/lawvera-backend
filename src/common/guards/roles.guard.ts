import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserRole } from '../enums/role.enum';
import { isAdminRole } from '../utils/role.utils';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const requiredRoles =
      this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('You do not have permission to proceed.');
    }

    const hasRequiredRole =
      requiredRoles.includes(user.role) ||
      (user.role === UserRole.SUPER_ADMIN &&
        requiredRoles.some((role) => isAdminRole(role)));

    if (!hasRequiredRole) {
      throw new ForbiddenException('You do not have permission to proceed.');
    }

    return true;
  }
}
