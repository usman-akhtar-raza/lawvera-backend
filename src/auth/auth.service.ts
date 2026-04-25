import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { User, UserDocument } from '../user/schemas/user.schema';
import {
  LawyerProfile,
  LawyerProfileDocument,
} from '../lawyer/schemas/lawyer-profile.schema';
import { RegisterClientDto } from './dto/register-client.dto';
import { RegisterLawyerDto } from './dto/register-lawyer.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { UserRole } from '../common/enums/role.enum';
import { AuthTokens } from './interfaces/auth-tokens.interface';
import { LawyerStatus } from '../common/enums/lawyer-status.enum';
import { JwtPayload } from '../common/interfaces/jwt-payload.interface';
import { OtpMailService } from './otp-mail.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const OTP_EXPIRY_MINUTES = 10;

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(LawyerProfile.name)
    private readonly lawyerModel: Model<LawyerProfileDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly otpMailService: OtpMailService,
  ) {}

  async registerClient(dto: RegisterClientDto) {
    const email = dto.email.toLowerCase();
    await this.ensureEmailAvailable(email);
    const password = await this.hashData(dto.password);

    const otp = this.otpMailService.generateOtp();
    const otpHash = await this.hashData(otp);

    const user = await this.userModel.create({
      ...dto,
      email,
      password,
      role: UserRole.CLIENT,
      isEmailVerified: false,
      otpCode: otpHash,
      otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
    });

    await this.otpMailService.sendOtp(email, otp);

    return {
      message: 'Registration successful. Please verify your email with the OTP sent.',
      email: user.email,
      requiresVerification: true,
    };
  }

  async registerLawyer(dto: RegisterLawyerDto) {
    const email = dto.email.toLowerCase();

    const existingUser = await this.userModel.findOne({ email });

    if (existingUser) {
      if (existingUser.role !== UserRole.CLIENT) {
        throw new BadRequestException('This email is already registered with a different account type');
      }

      const existingProfile = await this.lawyerModel.findOne({ user: existingUser._id });
      if (existingProfile) {
        throw new BadRequestException('A lawyer profile already exists for this account');
      }

      const passwordMatches = await bcrypt.compare(dto.password, existingUser.password);
      if (!passwordMatches) {
        throw new BadRequestException('Incorrect password for the existing account');
      }

      existingUser.role = UserRole.LAWYER;
      existingUser.city = dto.city || existingUser.city;
      await existingUser.save();

      await this.lawyerModel.create({
        user: existingUser._id,
        specialization: dto.specialization,
        experienceYears: dto.experienceYears,
        city: dto.city,
        consultationFee: dto.consultationFee,
        education: dto.education,
        description: dto.description,
        profilePhotoUrl: dto.profilePhotoUrl,
        availability: dto.availability,
        status: LawyerStatus.PENDING,
      });

      if (!existingUser.isEmailVerified) {
        const otp = this.otpMailService.generateOtp();
        const otpHash = await this.hashData(otp);
        existingUser.otpCode = otpHash;
        existingUser.otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
        await existingUser.save();
        await this.otpMailService.sendOtp(email, otp);
        return {
          message: 'Account upgraded to lawyer. Please verify your email.',
          email: existingUser.email,
          requiresVerification: true,
        };
      }

      const tokens = await this.generateTokens(existingUser);
      await this.setRefreshToken(existingUser.id, tokens.refreshToken);
      const lawyerProfile = await this.lawyerModel.findOne({ user: existingUser._id }).lean();
      return {
        user: this.sanitizeUser(existingUser),
        tokens,
        lawyerProfile,
      };
    }

    const password = await this.hashData(dto.password);
    const otp = this.otpMailService.generateOtp();
    const otpHash = await this.hashData(otp);

    const user = await this.userModel.create({
      name: dto.name,
      email,
      password,
      role: UserRole.LAWYER,
      city: dto.city,
      isEmailVerified: false,
      otpCode: otpHash,
      otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
    });

    await this.lawyerModel.create({
      user: user._id,
      specialization: dto.specialization,
      experienceYears: dto.experienceYears,
      city: dto.city,
      consultationFee: dto.consultationFee,
      education: dto.education,
      description: dto.description,
      profilePhotoUrl: dto.profilePhotoUrl,
      availability: dto.availability,
      status: LawyerStatus.PENDING,
    });

    await this.otpMailService.sendOtp(email, otp);

    return {
      message: 'Registration successful. Please verify your email with the OTP sent.',
      email: user.email,
      requiresVerification: true,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isEmailVerified) {
      return {
        message: 'Email not verified. Please verify your email first.',
        email: user.email,
        requiresVerification: true,
      };
    }

    const tokens = await this.generateTokens(user);
    await this.setRefreshToken(user.id, tokens.refreshToken);

    return { user: this.sanitizeUser(user), tokens };
  }

  async sendOtp(dto: SendOtpDto) {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (!user) {
      throw new BadRequestException('No account found with this email');
    }

    if (user.isEmailVerified) {
      return { message: 'Email is already verified' };
    }

    const otp = this.otpMailService.generateOtp();
    const otpHash = await this.hashData(otp);

    user.otpCode = otpHash;
    user.otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await user.save();

    await this.otpMailService.sendOtp(user.email, otp);

    return { message: 'OTP sent successfully', email: user.email };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (!user) {
      throw new BadRequestException('No account found with this email');
    }

    if (user.isEmailVerified) {
      const tokens = await this.generateTokens(user);
      await this.setRefreshToken(user.id, tokens.refreshToken);
      return { message: 'Email already verified', user: this.sanitizeUser(user), tokens };
    }

    if (!user.otpCode || !user.otpExpiresAt) {
      throw new BadRequestException('No OTP found. Please request a new one.');
    }

    if (new Date() > user.otpExpiresAt) {
      throw new BadRequestException('OTP has expired. Please request a new one.');
    }

    const otpMatches = await bcrypt.compare(dto.otp, user.otpCode);
    if (!otpMatches) {
      throw new BadRequestException('Invalid OTP');
    }

    user.isEmailVerified = true;
    user.otpCode = undefined;
    user.otpExpiresAt = undefined;
    await user.save();

    const tokens = await this.generateTokens(user);
    await this.setRefreshToken(user.id, tokens.refreshToken);

    const lawyerProfile =
      user.role === UserRole.LAWYER
        ? await this.lawyerModel.findOne({ user: user._id }).lean()
        : null;

    return {
      message: 'Email verified successfully',
      user: this.sanitizeUser(user),
      tokens,
      ...(lawyerProfile ? { lawyerProfile, profileStatus: LawyerStatus.PENDING } : {}),
    };
  }

  async requestPasswordReset(dto: RequestPasswordResetDto) {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    const response = {
      message:
        'If an account exists for this email, a password reset code has been sent.',
    };

    if (!user) {
      return response;
    }

    const otp = this.otpMailService.generateOtp();
    user.passwordResetCode = await this.hashData(otp);
    user.passwordResetExpiresAt = new Date(
      Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000,
    );
    await user.save();

    await this.otpMailService.sendPasswordResetOtp(user.email, otp);

    return response;
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (!user) {
      throw new BadRequestException('Invalid or expired password reset code.');
    }

    if (!user.passwordResetCode || !user.passwordResetExpiresAt) {
      throw new BadRequestException('Invalid or expired password reset code.');
    }

    if (new Date() > user.passwordResetExpiresAt) {
      throw new BadRequestException('Invalid or expired password reset code.');
    }

    const otpMatches = await bcrypt.compare(dto.otp, user.passwordResetCode);
    if (!otpMatches) {
      throw new BadRequestException('Invalid or expired password reset code.');
    }

    user.password = await this.hashData(dto.password);
    user.passwordResetCode = undefined;
    user.passwordResetExpiresAt = undefined;
    user.refreshTokenHash = undefined;
    await user.save();

    return { message: 'Password reset successful. Please sign in again.' };
  }

  async refreshTokens(dto: RefreshTokenDto) {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(
        dto.refreshToken,
        {
          secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
          algorithms: ['HS256'],
        },
      );
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.userModel.findById(payload.sub);
    if (!user || !user.refreshTokenHash) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.email !== user.email || payload.role !== user.role) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const refreshMatches = await bcrypt.compare(
      dto.refreshToken,
      user.refreshTokenHash,
    );

    if (!refreshMatches) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokens = await this.generateTokens(user);
    await this.setRefreshToken(user.id, tokens.refreshToken);
    return { user: this.sanitizeUser(user), tokens };
  }

  async getProfile(userId: string) {
    const user = await this.userModel
      .findById(userId)
      .select(
        '-password -refreshTokenHash -otpCode -otpExpiresAt -passwordResetCode -passwordResetExpiresAt',
      )
      .lean();
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const lawyerProfile =
      user.role === UserRole.LAWYER
        ? await this.lawyerModel.findOne({ user: userId }).lean()
        : null;
    return { ...user, lawyerProfile };
  }

  private async ensureEmailAvailable(email: string) {
    const existingUser = await this.userModel.exists({ email });
    if (existingUser) {
      throw new BadRequestException('Email already registered');
    }
  }

  private async hashData(data: string) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(data, salt);
  }

  private async generateTokens(user: UserDocument): Promise<AuthTokens> {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = await this.jwtService.signAsync(payload);
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: (this.configService.get<string>('JWT_REFRESH_EXPIRATION', '7d') ||
        '7d') as any,
    });

    return { accessToken, refreshToken };
  }

  private async setRefreshToken(userId: string, refreshToken: string) {
    const hash = await this.hashData(refreshToken);
    await this.userModel.findByIdAndUpdate(userId, {
      refreshTokenHash: hash,
    });
  }

  private sanitizeUser(user: UserDocument) {
    const obj = user.toObject();
    const {
      password,
      refreshTokenHash,
      otpCode,
      otpExpiresAt,
      passwordResetCode,
      passwordResetExpiresAt,
      ...sanitized
    } = obj;
    return sanitized;
  }
}
