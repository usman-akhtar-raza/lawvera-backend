import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { addDays, format } from 'date-fns';
import { Case, CaseDocument } from '../case/schemas/case.schema';
import {
  LawyerProfile,
  LawyerProfileDocument,
} from './schemas/lawyer-profile.schema';
import {
  Specialization,
  SpecializationDocument,
} from './schemas/specialization.schema';
import { ApplyAsLawyerDto } from '../auth/dto/apply-as-lawyer.dto';
import { CreateLawyerDto } from './dto/create-lawyer.dto';
import { UpdateLawyerDto } from './dto/update-lawyer.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { SearchLawyersDto } from './dto/search-lawyers.dto';
import { ManageSpecializationDto } from './dto/manage-specialization.dto';
import { CreateReviewDto } from './dto/create-review.dto';
import { LawyerStatus } from '../common/enums/lawyer-status.enum';
import { UserRole } from '../common/enums/role.enum';
import { User, UserDocument } from '../user/schemas/user.schema';
import { NotificationService } from '../common/services/notification.service';
import { Booking, BookingDocument } from '../booking/schemas/booking.schema';
import { BookingStatus } from '../common/enums/booking-status.enum';
import { CaseStatus } from '../common/enums/case-status.enum';
import { CaseRequestStatus } from '../common/enums/case-request-status.enum';

const LAWYER_BLOCKING_BOOKING_STATUSES = [
  BookingStatus.AWAITING_PAYMENT,
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

export interface ProfileSwitchStatus {
  canSwitchToLawyerProfile: boolean;
  canSwitchToClientProfile: boolean;
  switchToLawyerProfileReason: string | null;
  switchToClientProfileReason: string | null;
}

@Injectable()
export class LawyerService {
  constructor(
    @InjectModel(LawyerProfile.name)
    private readonly lawyerModel: Model<LawyerProfileDocument>,
    @InjectModel(Specialization.name)
    private readonly specializationModel: Model<SpecializationDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Booking.name)
    private readonly bookingModel: Model<BookingDocument>,
    @InjectModel(Case.name)
    private readonly caseModel: Model<CaseDocument>,
    private readonly notificationService: NotificationService,
  ) {}

  async applyAsLawyer(userId: string, dto: ApplyAsLawyerDto) {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new BadRequestException('User not found');
    }
    if (user.role !== UserRole.CLIENT) {
      throw new BadRequestException('Only clients can apply to become a lawyer');
    }

    const switchStatus = await this.buildClientSwitchStatus(userId);
    if (!switchStatus.canSwitchToLawyerProfile) {
      throw new BadRequestException(
        switchStatus.switchToLawyerProfileReason ||
          'You cannot switch to a lawyer profile right now.',
      );
    }

    const existingProfile = await this.lawyerModel.findOne({ user: userId });
    if (existingProfile) {
      throw new BadRequestException('A lawyer profile already exists for this account');
    }

    user.role = UserRole.LAWYER;
    await user.save();

    const lawyerProfile = await this.lawyerModel.create({
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

    return { user, lawyerProfile };
  }

  async revertToClient(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new BadRequestException('User not found');
    }
    if (user.role !== UserRole.LAWYER) {
      throw new BadRequestException('User is not currently a lawyer');
    }

    const switchStatus = await this.buildLawyerSwitchStatus(userId);
    if (!switchStatus.canSwitchToClientProfile) {
      throw new BadRequestException(
        switchStatus.switchToClientProfileReason ||
          'You cannot switch back to a client account right now.',
      );
    }

    user.role = UserRole.CLIENT;
    await user.save();
    // LawyerProfile is intentionally kept in DB
    return { user };
  }

  async getProfileSwitchStatus(userId: string): Promise<ProfileSwitchStatus> {
    const user = await this.userModel.findById(userId).select('role');
    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (user.role === UserRole.CLIENT) {
      return this.buildClientSwitchStatus(userId);
    }

    if (user.role === UserRole.LAWYER) {
      return this.buildLawyerSwitchStatus(userId);
    }

    return {
      canSwitchToLawyerProfile: false,
      canSwitchToClientProfile: false,
      switchToLawyerProfileReason: null,
      switchToClientProfileReason: null,
    };
  }

  async create(dto: CreateLawyerDto) {
    const user = await this.userModel.findById(dto.userId);
    if (!user) {
      throw new BadRequestException('User not found');
    }
    const existingProfile = await this.lawyerModel.findOne({ user: user._id });
    if (existingProfile) {
      throw new BadRequestException('Lawyer profile already exists');
    }
    const profile = await this.lawyerModel.create({
      ...dto,
      user: user._id,
      status: LawyerStatus.PENDING,
    });
    return profile;
  }

  async search(query: SearchLawyersDto) {
    const { page = 1, limit = 20, availability, ...filters } = query;
    const filterQuery: FilterQuery<LawyerProfile> = {
      status: LawyerStatus.APPROVED,
    };

    if (filters.specialization) {
      filterQuery.specialization = {
        $regex: filters.specialization,
        $options: 'i',
      };
    }
    if (filters.city) {
      filterQuery.city = { $regex: filters.city, $options: 'i' };
    }
    if (filters.minFee || filters.maxFee) {
      const feeFilter: Record<string, number> = {};
      if (filters.minFee !== undefined) {
        feeFilter.$gte = filters.minFee;
      }
      if (filters.maxFee !== undefined) {
        feeFilter.$lte = filters.maxFee;
      }
      filterQuery.consultationFee = feeFilter as any;
    }
    if (filters.minExperience) {
      filterQuery.experienceYears = { $gte: filters.minExperience } as any;
    }
    if (filters.minRating) {
      filterQuery.ratingAverage = { $gte: filters.minRating } as any;
    }
    if (availability) {
      const targetDay =
        availability === 'tomorrow'
          ? format(addDays(new Date(), 1), 'EEEE')
          : format(new Date(), 'EEEE');
      filterQuery.availability = {
        $elemMatch: { day: targetDay, slots: { $exists: true, $ne: [] } },
      } as any;
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.lawyerModel
        .find(filterQuery)
        .populate('user', 'name email city avatarUrl')
        .skip(skip)
        .limit(limit)
        .lean(),
      this.lawyerModel.countDocuments(filterQuery),
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

  async findById(id: string) {
    const profile = await this.lawyerModel
      .findById(id)
      .populate('user', 'name email city avatarUrl phone')
      .lean();
    if (!profile) {
      throw new NotFoundException('Lawyer not found');
    }
    return profile;
  }

  async findByUserId(userId: string) {
    const profile = await this.lawyerModel
      .findOne({ user: userId })
      .populate('user', 'name email city avatarUrl phone')
      .lean();
    if (!profile) {
      throw new NotFoundException('Lawyer not found');
    }
    return profile;
  }

  async update(id: string, dto: UpdateLawyerDto) {
    const updated = await this.lawyerModel
      .findByIdAndUpdate(id, dto, { new: true })
      .populate('user', 'name email city avatarUrl phone');
    if (!updated) {
      throw new NotFoundException('Lawyer profile not found');
    }
    return updated;
  }

  async updateAvailability(userId: string, dto: UpdateAvailabilityDto) {
    const profile = await this.lawyerModel.findOneAndUpdate(
      { user: userId },
      { availability: dto.availability },
      { new: true },
    );
    if (!profile) {
      throw new NotFoundException('Lawyer profile not found');
    }
    return profile;
  }

  async addReview(lawyerId: string, clientId: string, dto: CreateReviewDto) {
    const profile = await this.lawyerModel.findById(lawyerId);
    if (!profile) {
      throw new NotFoundException('Lawyer not found');
    }
    profile.reviews.push({
      client: clientId as any,
      rating: dto.rating,
      comment: dto.comment,
      createdAt: new Date(),
    } as any);
    profile.ratingCount = profile.reviews.length;
    profile.ratingAverage =
      profile.reviews.reduce((acc, review) => acc + review.rating, 0) /
      profile.ratingCount;
    await profile.save();
    return profile;
  }

  async approveLawyer(lawyerId: string) {
    const profile = await this.lawyerModel
      .findByIdAndUpdate(lawyerId, { status: LawyerStatus.APPROVED }, { new: true })
      .populate<{ user: { _id: string; name: string; email: string } }>('user', 'name email');
    if (!profile) {
      throw new NotFoundException('Lawyer not found');
    }
    await this.notificationService.sendApprovalEmail(profile.user.email, profile.user.name);
    return profile;
  }

  async rejectLawyer(lawyerId: string) {
    const profile = await this.lawyerModel
      .findByIdAndUpdate(lawyerId, { status: LawyerStatus.REJECTED }, { new: true })
      .populate<{ user: { _id: string; name: string; email: string } }>('user', 'name email');
    if (!profile) {
      throw new NotFoundException('Lawyer not found');
    }
    // Revert role to CLIENT so rejected lawyer is not locked out
    await this.userModel.findByIdAndUpdate(profile.user._id, { role: UserRole.CLIENT });
    await this.notificationService.sendRejectionEmail(profile.user.email, profile.user.name);
    return profile;
  }

  listSpecializations() {
    return this.specializationModel.find().lean();
  }

  private async buildClientSwitchStatus(
    userId: string,
  ): Promise<ProfileSwitchStatus> {
    const inProgressCaseCount = await this.caseModel.countDocuments({
      client: userId,
      status: CaseStatus.IN_PROGRESS,
    });

    return {
      canSwitchToLawyerProfile: inProgressCaseCount === 0,
      canSwitchToClientProfile: false,
      switchToLawyerProfileReason:
        inProgressCaseCount > 0
          ? 'You cannot switch to a lawyer profile while you have a case in progress as a client.'
          : null,
      switchToClientProfileReason: null,
    };
  }

  private async buildLawyerSwitchStatus(
    userId: string,
  ): Promise<ProfileSwitchStatus> {
    const profile = await this.lawyerModel.findOne({ user: userId }).select('_id');
    if (!profile) {
      return {
        canSwitchToLawyerProfile: false,
        canSwitchToClientProfile: false,
        switchToLawyerProfileReason: null,
        switchToClientProfileReason: 'Lawyer profile not found.',
      };
    }

    const [activeBookingCount, activeCaseCount, pendingCaseRequestCount] =
      await Promise.all([
        this.bookingModel.countDocuments({
          lawyer: profile._id,
          status: { $in: LAWYER_BLOCKING_BOOKING_STATUSES },
        }),
        this.caseModel.countDocuments({
          lawyer: profile._id,
          status: { $ne: CaseStatus.CLOSED },
        }),
        this.caseModel.countDocuments({
          status: CaseStatus.OPEN,
          lawyerRequests: {
            $elemMatch: {
              lawyer: profile._id,
              status: CaseRequestStatus.PENDING,
            },
          },
        }),
      ]);

    const canSwitchToClientProfile =
      activeBookingCount === 0 &&
      activeCaseCount === 0 &&
      pendingCaseRequestCount === 0;

    return {
      canSwitchToLawyerProfile: false,
      canSwitchToClientProfile,
      switchToLawyerProfileReason: null,
      switchToClientProfileReason: canSwitchToClientProfile
        ? null
        : this.buildLawyerSwitchBlockReason(
            activeBookingCount,
            activeCaseCount,
            pendingCaseRequestCount,
          ),
    };
  }

  private buildLawyerSwitchBlockReason(
    activeBookingCount: number,
    activeCaseCount: number,
    pendingCaseRequestCount: number,
  ) {
    const blockers: string[] = [];

    if (activeBookingCount > 0) {
      blockers.push(
        `${activeBookingCount} active booking${activeBookingCount === 1 ? '' : 's'}`,
      );
    }

    if (activeCaseCount > 0) {
      blockers.push(
        `${activeCaseCount} active case${activeCaseCount === 1 ? '' : 's'}`,
      );
    }

    if (pendingCaseRequestCount > 0) {
      blockers.push(
        `${pendingCaseRequestCount} pending case request${
          pendingCaseRequestCount === 1 ? '' : 's'
        }`,
      );
    }

    if (blockers.length === 0) {
      return 'You cannot switch back to a client account right now.';
    }

    if (blockers.length === 1) {
      return `You cannot switch back to a client account while you still have ${blockers[0]}.`;
    }

    const lastBlocker = blockers[blockers.length - 1];
    const leadingBlockers = blockers.slice(0, -1).join(', ');
    return `You cannot switch back to a client account while you still have ${leadingBlockers} and ${lastBlocker}.`;
  }

  createSpecialization(dto: ManageSpecializationDto) {
    return this.specializationModel.create(dto);
  }

  updateSpecialization(id: string, dto: ManageSpecializationDto) {
    return this.specializationModel.findByIdAndUpdate(id, dto, { new: true });
  }

  removeSpecialization(id: string) {
    return this.specializationModel.findByIdAndDelete(id);
  }

  async getDashboard(lawyerUserId: string) {
    const profile = await this.lawyerModel.findOne({ user: lawyerUserId });
    if (!profile) {
      throw new NotFoundException('Lawyer profile not found');
    }

    const [upcoming, pending, completed] = await Promise.all([
      this.bookingModel
        .find({
          lawyer: profile._id,
          status: BookingStatus.CONFIRMED,
          slotDate: { $gte: new Date() },
        })
        .populate('client', 'name email city')
        .lean(),
      this.bookingModel
        .find({
          lawyer: profile._id,
          status: BookingStatus.PENDING,
        })
        .populate('client', 'name email city')
        .lean(),
      this.bookingModel
        .find({
          lawyer: profile._id,
          status: BookingStatus.COMPLETED,
        })
        .lean(),
    ]);

    return {
      profile,
      stats: {
        pending: pending.length,
        upcoming: upcoming.length,
        completed: completed.length,
      },
      pending,
      upcoming,
    };
  }

  async getAdminOverview() {
    const [pending, total, approved] = await Promise.all([
      this.lawyerModel
        .find({ status: LawyerStatus.PENDING })
        .populate('user', 'name email city')
        .lean(),
      this.lawyerModel.countDocuments(),
      this.lawyerModel.countDocuments({ status: LawyerStatus.APPROVED }),
    ]);

    return {
      pending,
      metrics: {
        total,
        approved,
        pending: pending.length,
      },
    };
  }
}
