import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type RateBucket = {
  count: number;
  resetAt: number;
};

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly windowMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly configService: ConfigService) {
    this.windowMs = Number(
      this.configService.get<string>('AUTH_RATE_LIMIT_WINDOW_MS', '60000'),
    );
    this.maxAttempts = Number(
      this.configService.get<string>('AUTH_RATE_LIMIT_MAX_ATTEMPTS', '10'),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      ip?: string;
      path?: string;
      route?: { path?: string };
      headers?: Record<string, string | string[] | undefined>;
    }>();

    const ip = this.getClientIp(request);
    const path = request.route?.path || request.path || 'unknown-path';
    const key = `${ip}:${path}`;
    const now = Date.now();

    this.pruneExpired(now);

    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      return true;
    }

    if (bucket.count >= this.maxAttempts) {
      throw new HttpException(
        'Too many authentication attempts. Please try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
    return true;
  }

  private getClientIp(request: {
    ip?: string;
    headers?: Record<string, string | string[] | undefined>;
  }): string {
    const forwardedFor = request.headers?.['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
      return forwardedFor.split(',')[0]?.trim() || request.ip || 'unknown-ip';
    }

    if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
      const first = forwardedFor[0];
      if (typeof first === 'string' && first.length > 0) {
        return first.split(',')[0]?.trim() || request.ip || 'unknown-ip';
      }
    }

    return request.ip || 'unknown-ip';
  }

  private pruneExpired(now: number) {
    if (this.buckets.size < 500) {
      return;
    }

    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
  }
}
