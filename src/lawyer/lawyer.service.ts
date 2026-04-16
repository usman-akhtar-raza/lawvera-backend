import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { addDays, format } from 'date-fns';
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
    user.role = UserRole.CLIENT;
    await user.save();
    // LawyerProfile is intentionally kept in DB
    return { user };
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
    const profile = await this.lawyerModel.findByIdAndUpdate(
      lawyerId,
      { status: LawyerStatus.APPROVED },
      { new: true },
    );
    if (!profile) {
      throw new NotFoundException('Lawyer not found');
    }
    await this.notificationService.notifyLawyer(
      profile.user.toString(),
      'Your Lawvera profile has been approved.',
    );
    return profile;
  }

  async rejectLawyer(lawyerId: string) {
    const profile = await this.lawyerModel.findByIdAndUpdate(
      lawyerId,
      { status: LawyerStatus.REJECTED },
      { new: true },
    );
    if (!profile) {
      throw new NotFoundException('Lawyer not found');
    }
    await this.notificationService.notifyLawyer(
      profile.user.toString(),
      'Your Lawvera profile has been rejected.',
    );
    return profile;
  }

  listSpecializations() {
    return this.specializationModel.find().lean();
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
