import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateManagedUserDto } from './dto/create-managed-user.dto';
import { SearchUsersDto } from './dto/search-users.dto';
import {
  LawyerProfile,
  LawyerProfileDocument,
} from '../lawyer/schemas/lawyer-profile.schema';
import { UserRole } from '../common/enums/role.enum';
import { LawyerStatus } from '../common/enums/lawyer-status.enum';
import { UserDetailResponse } from './types/user-detail-response.type';

const SAFE_USER_PROJECTION =
  '-password -refreshTokenHash -otpCode -otpExpiresAt -passwordResetCode -passwordResetExpiresAt';
const LAWYER_PROFILE_DETAIL_PROJECTION =
  'specialization experienceYears city consultationFee education description availability status ratingAverage ratingCount profilePhotoUrl createdAt updatedAt';

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(LawyerProfile.name)
    private readonly lawyerProfileModel: Model<LawyerProfileDocument>,
  ) {}

  async findAll(query: SearchUsersDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 50);
    const skip = (page - 1) * limit;
    const filterQuery: FilterQuery<User> = {};
    const search = query.search?.trim();

    if (search) {
      const escapedSearch = this.escapeRegExp(search);
      const normalizedRoleSearch = this.escapeRegExp(
        search.toLowerCase().replace(/\s+/g, '_'),
      );

      filterQuery.$or = [
        { name: { $regex: escapedSearch, $options: 'i' } },
        { email: { $regex: escapedSearch, $options: 'i' } },
        { city: { $regex: escapedSearch, $options: 'i' } },
        { phone: { $regex: escapedSearch, $options: 'i' } },
        { role: { $regex: normalizedRoleSearch, $options: 'i' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.userModel
        .find(filterQuery)
        .select(SAFE_USER_PROJECTION)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.userModel.countDocuments(filterQuery),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
      },
    };
  }

  findAdminUsers() {
    return this.userModel
      .find({
        role: { $in: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
      })
      .select(SAFE_USER_PROJECTION)
      .sort({ createdAt: -1 });
  }

  async findById(id: string): Promise<UserDetailResponse> {
    const user = await this.userModel
      .findById(id)
      .select(SAFE_USER_PROJECTION)
      .lean();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    let lawyerProfile: LawyerProfile | null = null;

    if (user.role === UserRole.LAWYER) {
      lawyerProfile = await this.lawyerProfileModel
        .findOne({ user: user._id })
        .select(LAWYER_PROFILE_DETAIL_PROJECTION)
        .populate('user', 'name email city phone avatarUrl role')
        .lean();
    }

    return {
      user,
      lawyerProfile,
    };
  }

  async createManagedUser(dto: CreateManagedUserDto) {
    const email = dto.email.toLowerCase();
    const existingUser = await this.userModel.exists({ email });

    if (existingUser) {
      throw new BadRequestException('Email already registered');
    }

    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException(
        'Super admin accounts cannot be created here.',
      );
    }

    if (dto.role === UserRole.LAWYER) {
      if (!dto.city) {
        throw new BadRequestException('City is required for lawyer accounts.');
      }

      if (!dto.specialization) {
        throw new BadRequestException(
          'Specialization is required for lawyer accounts.',
        );
      }

      if (dto.experienceYears === undefined) {
        throw new BadRequestException(
          'Experience years is required for lawyer accounts.',
        );
      }

      if (dto.consultationFee === undefined) {
        throw new BadRequestException(
          'Consultation fee is required for lawyer accounts.',
        );
      }
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.userModel.create({
      name: dto.name,
      email,
      password: hashedPassword,
      role: dto.role,
      city: dto.city,
      phone: dto.phone,
      isEmailVerified: true,
    });

    let lawyerProfile: LawyerProfileDocument | null = null;

    if (dto.role === UserRole.LAWYER) {
      lawyerProfile = await this.lawyerProfileModel.create({
        user: user._id,
        specialization: dto.specialization,
        experienceYears: dto.experienceYears,
        city: dto.city,
        consultationFee: dto.consultationFee,
        education: dto.education,
        description: dto.description,
        availability: [],
        status: LawyerStatus.APPROVED,
      });
    }

    return {
      user: this.sanitizeUser(user),
      lawyerProfile,
    };
  }

  async update(id: string, dto: UpdateUserDto) {
    const updated = await this.userModel
      .findByIdAndUpdate(id, dto, { new: true })
      .select(SAFE_USER_PROJECTION);
    if (!updated) {
      throw new NotFoundException('User not found');
    }
    return updated;
  }

  private sanitizeUser(user: UserDocument) {
    const sanitized = user.toObject() as unknown as Record<string, unknown>;
    delete sanitized.password;
    delete sanitized.refreshTokenHash;
    delete sanitized.otpCode;
    delete sanitized.otpExpiresAt;
    delete sanitized.passwordResetCode;
    delete sanitized.passwordResetExpiresAt;
    return sanitized;
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
