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

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(LawyerProfile.name)
    private readonly lawyerModel: Model<LawyerProfileDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async registerClient(dto: RegisterClientDto) {
    const email = dto.email.toLowerCase();
    await this.ensureEmailAvailable(email);
    const password = await this.hashData(dto.password);
    const user = await this.userModel.create({
      ...dto,
      email,
      password,
      role: UserRole.CLIENT,
    });

    const tokens = await this.generateTokens(user);
    await this.setRefreshToken(user.id, tokens.refreshToken);
    return { user: this.sanitizeUser(user), tokens };
  }

  async registerLawyer(dto: RegisterLawyerDto) {
    const email = dto.email.toLowerCase();
    await this.ensureEmailAvailable(email);
    const password = await this.hashData(dto.password);
    const user = await this.userModel.create({
      name: dto.name,
      email,
      password,
      role: UserRole.LAWYER,
      city: dto.city,
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

    const tokens = await this.generateTokens(user);
    await this.setRefreshToken(user.id, tokens.refreshToken);
    return {
      user: this.sanitizeUser(user),
      tokens,
      profileStatus: LawyerStatus.PENDING,
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

    const tokens = await this.generateTokens(user);
    await this.setRefreshToken(user.id, tokens.refreshToken);

    return { user: this.sanitizeUser(user), tokens };
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
      .select('-password -refreshTokenHash')
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
    const { password, refreshTokenHash, ...sanitized } = obj;
    return sanitized;
  }
}
