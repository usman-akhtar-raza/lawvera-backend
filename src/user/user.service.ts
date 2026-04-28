import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateManagedUserDto } from './dto/create-managed-user.dto';
import { SearchUsersDto } from './dto/search-users.dto';
import { UpdateManagedUserRoleDto } from './dto/update-managed-user-role.dto';
import { UpdateManagedUserStatusDto } from './dto/update-managed-user-status.dto';
import {
  LawyerProfile,
  LawyerProfileDocument,
} from '../lawyer/schemas/lawyer-profile.schema';
import { UserRole } from '../common/enums/role.enum';
import { LawyerStatus } from '../common/enums/lawyer-status.enum';
import { UserDetailResponse } from './types/user-detail-response.type';
import { Booking, BookingDocument } from '../booking/schemas/booking.schema';
import { Case, CaseDocument } from '../case/schemas/case.schema';
import { LawyerService } from '../lawyer/lawyer.service';
import {
  ChatMessage,
  ChatMessageDocument,
} from '../chat/schemas/chat-message.schema';
import {
  CommunicationMessage,
  CommunicationMessageDocument,
} from '../communication/schemas/communication-message.schema';
import {
  CommunicationThread,
  CommunicationThreadDocument,
} from '../communication/schemas/communication-thread.schema';

type ManagementActor = {
  userId: string;
  role: UserRole;
};

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
    @InjectModel(Booking.name)
    private readonly bookingModel: Model<BookingDocument>,
    @InjectModel(Case.name)
    private readonly caseModel: Model<CaseDocument>,
    @InjectModel(ChatMessage.name)
    private readonly chatMessageModel: Model<ChatMessageDocument>,
    @InjectModel(CommunicationMessage.name)
    private readonly communicationMessageModel: Model<CommunicationMessageDocument>,
    @InjectModel(CommunicationThread.name)
    private readonly communicationThreadModel: Model<CommunicationThreadDocument>,
    private readonly lawyerService: LawyerService,
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
      data: data.map((user) => this.normalizeUserStatus(user)),
      meta: {
        total,
        page,
        limit,
      },
    };
  }

  async findAdminUsers() {
    const users = await this.userModel
      .find({
        role: { $in: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
      })
      .select(SAFE_USER_PROJECTION)
      .sort({ createdAt: -1 })
      .lean();

    return users.map((user) => this.normalizeUserStatus(user));
  }

  async findById(id: string): Promise<UserDetailResponse> {
    const user = await this.userModel
      .findById(id)
      .select(SAFE_USER_PROJECTION)
      .lean();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const lawyerProfile = await this.lawyerProfileModel
      .findOne({ user: user._id })
      .select(LAWYER_PROFILE_DETAIL_PROJECTION)
      .populate('user', 'name email city phone avatarUrl role')
      .lean();

    return {
      user: this.normalizeUserStatus(user),
      lawyerProfile,
    };
  }

  async updateManagedRole(
    actor: ManagementActor,
    userId: string,
    dto: UpdateManagedUserRoleDto,
  ): Promise<UserDetailResponse> {
    const target = await this.getManageableTarget(actor, userId, 'role');

    if (dto.role !== UserRole.CLIENT && dto.role !== UserRole.LAWYER) {
      throw new BadRequestException(
        'Role management only supports switching between user and lawyer.',
      );
    }

    if (target.role !== UserRole.CLIENT && target.role !== UserRole.LAWYER) {
      throw new BadRequestException(
        'Only user and lawyer accounts can be switched here.',
      );
    }

    if (target.role === dto.role) {
      return this.findById(userId);
    }

    if (dto.role === UserRole.CLIENT) {
      await this.lawyerService.revertToClient(userId);
      return this.findById(userId);
    }

    await this.lawyerService.reactivateLawyerProfile(userId);
    await this.lawyerProfileModel.findOneAndUpdate(
      { user: userId },
      { status: LawyerStatus.APPROVED },
    );

    return this.findById(userId);
  }

  async updateManagedStatus(
    actor: ManagementActor,
    userId: string,
    dto: UpdateManagedUserStatusDto,
  ): Promise<UserDetailResponse> {
    const target = await this.getManageableTarget(actor, userId, 'status');
    const updates: Partial<User> = {
      isActive: dto.isActive,
    };

    if (!dto.isActive) {
      updates.refreshTokenHash = undefined;
    }

    await this.userModel.findByIdAndUpdate(target._id, updates);
    return this.findById(userId);
  }

  async deleteManagedUser(
    actor: ManagementActor,
    userId: string,
  ): Promise<{ success: true }> {
    const target = await this.getManageableTarget(actor, userId, 'delete');
    const lawyerProfile = await this.lawyerProfileModel
      .findOne({ user: target._id })
      .select('_id')
      .lean();

    const blockerCount = await this.getDeletionBlockerCount(
      target._id,
      lawyerProfile?._id,
    );

    if (blockerCount > 0) {
      throw new BadRequestException(
        'This account cannot be deleted because it has linked platform records. Disable it instead.',
      );
    }

    if (lawyerProfile?._id) {
      await this.lawyerProfileModel.findByIdAndDelete(lawyerProfile._id);
    }

    await this.userModel.findByIdAndDelete(target._id);
    return { success: true };
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

  private async getManageableTarget(
    actor: ManagementActor,
    userId: string,
    action: 'role' | 'status' | 'delete',
  ) {
    if (actor.userId === userId) {
      throw new BadRequestException('You cannot manage your own account.');
    }

    const target = await this.userModel.findById(userId);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    if (target.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Super admin accounts cannot be managed from this tool.',
      );
    }

    if (target.role === UserRole.ADMIN) {
      if (actor.role !== UserRole.SUPER_ADMIN) {
        throw new ForbiddenException(
          'Only a super admin can manage admin accounts.',
        );
      }

      if (action === 'role') {
        throw new BadRequestException(
          'Admin accounts cannot be switched to another role here.',
        );
      }
    }

    return target;
  }

  private async getDeletionBlockerCount(
    userId: Types.ObjectId,
    lawyerProfileId?: Types.ObjectId,
  ) {
    const [
      clientBookingCount,
      clientCaseCount,
      caseActorCount,
      reviewCount,
      chatCount,
    ] = await Promise.all([
      this.bookingModel.countDocuments({ client: userId }),
      this.caseModel.countDocuments({ client: userId }),
      this.caseModel.countDocuments({ 'activityLog.actor': userId }),
      this.lawyerProfileModel.countDocuments({ 'reviews.client': userId }),
      this.chatMessageModel.countDocuments({ user: userId }),
    ]);

    const [communicationMessageCount, communicationThreadCount] =
      await Promise.all([
        this.communicationMessageModel.countDocuments({ sender: userId }),
        this.communicationThreadModel.countDocuments({ participants: userId }),
      ]);

    let lawyerLinkedCount = 0;

    if (lawyerProfileId) {
      const [lawyerBookingCount, assignedCaseCount, caseRequestCount] =
        await Promise.all([
          this.bookingModel.countDocuments({ lawyer: lawyerProfileId }),
          this.caseModel.countDocuments({ lawyer: lawyerProfileId }),
          this.caseModel.countDocuments({
            'lawyerRequests.lawyer': lawyerProfileId,
          }),
        ]);

      lawyerLinkedCount =
        lawyerBookingCount + assignedCaseCount + caseRequestCount;
    }

    return (
      clientBookingCount +
      clientCaseCount +
      caseActorCount +
      reviewCount +
      chatCount +
      communicationMessageCount +
      communicationThreadCount +
      lawyerLinkedCount
    );
  }

  private normalizeUserStatus<T extends { isActive?: boolean | null }>(
    user: T,
  ): T & { isActive: boolean } {
    return {
      ...user,
      isActive: user.isActive !== false,
    };
  }
}
