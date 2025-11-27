import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Booking, BookingDocument } from './schemas/booking.schema';
import {
  LawyerProfile,
  LawyerProfileDocument,
} from '../lawyer/schemas/lawyer-profile.schema';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BookingStatus } from '../common/enums/booking-status.enum';
import { UpdateBookingStatusDto } from './dto/update-booking-status.dto';
import { NotificationService } from '../common/services/notification.service';
import { LawyerStatus } from '../common/enums/lawyer-status.enum';
import { UserRole } from '../common/enums/role.enum';

@Injectable()
export class BookingService {
  constructor(
    @InjectModel(Booking.name)
    private readonly bookingModel: Model<BookingDocument>,
    @InjectModel(LawyerProfile.name)
    private readonly lawyerModel: Model<LawyerProfileDocument>,
    private readonly notificationService: NotificationService,
  ) {}

  async create(clientId: string, dto: CreateBookingDto) {
    const lawyerProfile = await this.lawyerModel.findById(dto.lawyerId);
    if (!lawyerProfile || lawyerProfile.status !== LawyerStatus.APPROVED) {
      throw new BadRequestException(
        'Cannot book an appointment with this lawyer yet.',
      );
    }

    const slotDate = new Date(dto.slotDate);
    const existingBooking = await this.bookingModel.exists({
      lawyer: lawyerProfile._id,
      slotDate,
      slotTime: dto.slotTime,
      status: { $in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] },
    });

    if (existingBooking) {
      throw new BadRequestException('This time slot is no longer available.');
    }

    const booking = await this.bookingModel.create({
      client: clientId,
      lawyer: lawyerProfile._id,
      slotDate,
      slotTime: dto.slotTime,
      status: dto.status ?? BookingStatus.PENDING,
      reason: dto.reason,
      notes: dto.notes,
    });

    await this.notificationService.notifyLawyer(
      lawyerProfile.user.toString(),
      'You have a new appointment request on Lawvera.',
    );

    return booking.populate([
      { path: 'client', select: 'name email city' },
      { path: 'lawyer', populate: { path: 'user', select: 'name city' } },
    ]);
  }

  async getClientBookings(clientId: string) {
    return this.bookingModel
      .find({ client: clientId })
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name city specialization' },
      })
      .sort({ slotDate: -1 });
  }

  async getLawyerBookings(lawyerUserId: string) {
    const profile = await this.lawyerModel.findOne({ user: lawyerUserId });
    if (!profile) {
      throw new NotFoundException('Lawyer profile not found');
    }
    return this.bookingModel
      .find({ lawyer: profile._id })
      .populate('client', 'name email city phone')
      .sort({ slotDate: -1 });
  }

  async updateStatus(
    bookingId: string,
    dto: UpdateBookingStatusDto,
    actor: { userId: string; role: UserRole },
  ) {
    const booking = await this.bookingModel
      .findById(bookingId)
      .populate('client', 'name email')
      .populate('lawyer');
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (actor.role === UserRole.LAWYER) {
      const lawyerProfile = await this.lawyerModel.findOne({
        user: actor.userId,
      });
      if (
        !lawyerProfile ||
        booking.lawyer.toString() !== lawyerProfile._id.toString()
      ) {
        throw new UnauthorizedException();
      }
    } else if (actor.role !== UserRole.ADMIN) {
      throw new UnauthorizedException();
    }

    const lawyerProfileDoc = await this.lawyerModel.findById(booking.lawyer);

    booking.status = dto.status;
    booking.notes = dto.notes ?? booking.notes;
    await booking.save();

    await this.notificationService.notifyClient(
      booking.client.toString(),
      `Your booking status is now ${dto.status}.`,
    );

    if (lawyerProfileDoc) {
      await this.notificationService.notifyLawyer(
        lawyerProfileDoc.user.toString(),
        'A booking status was updated.',
      );
    }

    return booking;
  }

  async cancelBooking(
    bookingId: string,
    actorUserId: string,
    role: UserRole,
  ) {
    const booking = await this.bookingModel.findById(bookingId);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (role === UserRole.CLIENT && booking.client.toString() !== actorUserId) {
      throw new UnauthorizedException();
    }

    if (role === UserRole.LAWYER) {
      const profile = await this.lawyerModel.findOne({ user: actorUserId });
      if (!profile || booking.lawyer.toString() !== profile._id.toString()) {
        throw new UnauthorizedException();
      }
    }

    booking.status = BookingStatus.CANCELLED;
    await booking.save();
    const lawyerProfile = await this.lawyerModel.findById(booking.lawyer);
    if (lawyerProfile) {
      await this.notificationService.notifyLawyer(
        lawyerProfile.user.toString(),
        'A booking has been cancelled.',
      );
    }
    return booking;
  }

  async adminBookings() {
    return this.bookingModel
      .find()
      .populate('client', 'name email')
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name email specialization' },
      })
      .sort({ createdAt: -1 });
  }

  async analytics() {
    const [total, confirmed, today] = await Promise.all([
      this.bookingModel.countDocuments(),
      this.bookingModel.countDocuments({ status: BookingStatus.CONFIRMED }),
      this.bookingModel.countDocuments({
        slotDate: {
          $gte: new Date(new Date().setHours(0, 0, 0, 0)),
          $lte: new Date(new Date().setHours(23, 59, 59, 999)),
        },
      }),
    ]);

    return {
      total,
      confirmed,
      today,
    };
  }
}
