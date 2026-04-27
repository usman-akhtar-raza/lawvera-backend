import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User, UserSchema } from '../user/schemas/user.schema';
import {
  LawyerProfile,
  LawyerProfileSchema,
} from '../lawyer/schemas/lawyer-profile.schema';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard';
import { OtpMailService } from './otp-mail.service';
import { LawyerModule } from '../lawyer/lawyer.module';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    LawyerModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: (configService.get<string>('JWT_EXPIRATION', '15m') ||
            '15m') as any,
        },
      }),
    }),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: LawyerProfile.name, schema: LawyerProfileSchema },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, AuthRateLimitGuard, OtpMailService],
  exports: [AuthService],
})
export class AuthModule {}
