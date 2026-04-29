import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import Jazzcash from 'jazzcash-checkout';
import { Booking, BookingDocument } from './schemas/booking.schema';
import {
  LawyerProfile,
  LawyerProfileDocument,
} from '../lawyer/schemas/lawyer-profile.schema';
import { User, UserDocument } from '../user/schemas/user.schema';
import { Case, CaseDocument } from '../case/schemas/case.schema';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BookingStatus } from '../common/enums/booking-status.enum';
import { UpdateBookingStatusDto } from './dto/update-booking-status.dto';
import { UpdateBookingMeetingLinkDto } from './dto/update-booking-meeting-link.dto';
import { NotificationService } from '../common/services/notification.service';
import { LawyerStatus } from '../common/enums/lawyer-status.enum';
import { UserRole } from '../common/enums/role.enum';
import { PaymentStatus } from '../common/enums/payment-status.enum';
import { isAdminRole } from '../common/utils/role.utils';
import { CaseEscrowStatus } from '../common/enums/case-escrow-status.enum';

type CurrentActor = { userId: string; role: UserRole };

type JazzCashConfig = {
  backendPublicUrl: string;
  frontendAppUrl: string;
  merchantId: string;
  password: string;
  integritySalt: string;
  gatewayUrl: string;
  language: string;
  txnType: string;
  paymentWindowMinutes: number;
};

type PopulatedUserSummary = {
  _id?: Types.ObjectId | string;
  name?: string;
  email?: string;
  phone?: string;
  city?: string;
};

type PopulatedLawyerSummary = {
  _id?: Types.ObjectId | string;
  specialization?: string;
  user?: PopulatedUserSummary;
};

type FinanceTransactionRecord = {
  id: string;
  bookingId: string | null;
  caseId: string | null;
  sourceType: 'booking' | 'case';
  title: string;
  direction: 'paid' | 'received';
  counterparty: ReturnType<BookingService['buildCounterpartySummary']>;
  lawyerSpecialization: string | null;
  amountMinor: number;
  currency: string;
  provider: string;
  paymentStatus: string;
  bookingStatus: string | null;
  caseStatus: string | null;
  escrowStatus: string | null;
  txnRefNo: string;
  paidAt: string | null;
  appointmentDate: string | null;
  slotTime: string | null;
  reason: string | null;
};

@Injectable()
export class BookingService {
  private static readonly DEFAULT_PAYMENT_WINDOW_MINUTES = 15;

  constructor(
    @InjectModel(Booking.name)
    private readonly bookingModel: Model<BookingDocument>,
    @InjectModel(LawyerProfile.name)
    private readonly lawyerModel: Model<LawyerProfileDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Case.name)
    private readonly caseModel: Model<CaseDocument>,
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
  ) {}

  async createCheckout(clientId: string, dto: CreateBookingDto) {
    await this.expireStalePaymentReservations();

    const jazzCash = this.getJazzCashConfig();
    const client = await this.userModel
      .findById(clientId)
      .select('name email phone')
      .lean();

    if (!client) {
      throw new NotFoundException('Client not found.');
    }

    const lawyerProfile = await this.lawyerModel
      .findById(dto.lawyerId)
      .populate('user', 'name')
      .lean();

    if (!lawyerProfile || lawyerProfile.status !== LawyerStatus.APPROVED) {
      throw new BadRequestException(
        'Cannot book an appointment with this lawyer yet.',
      );
    }

    const slotDate = new Date(dto.slotDate);
    if (Number.isNaN(slotDate.getTime())) {
      throw new BadRequestException('Invalid appointment date.');
    }

    if (slotDate <= new Date()) {
      throw new BadRequestException('Please choose a future appointment date.');
    }

    this.assertSlotMatchesAvailability(lawyerProfile, slotDate, dto.slotTime);
    await this.ensureSlotAvailable(
      new Types.ObjectId(String(lawyerProfile._id)),
      slotDate,
      dto.slotTime,
    );

    const consultationFee = this.normalizeConsultationFee(
      lawyerProfile.consultationFee,
    );
    const amountMinor = Math.round(consultationFee * 100);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + jazzCash.paymentWindowMinutes * 60 * 1000,
    );
    const txnRefNo = this.generateTxnRefNo(now);

    const booking = new this.bookingModel({
      client: new Types.ObjectId(clientId),
      lawyer: new Types.ObjectId(String(lawyerProfile._id)),
      slotDate,
      slotTime: dto.slotTime,
      consultationFee,
      status: BookingStatus.AWAITING_PAYMENT,
      reason: dto.reason?.trim() || undefined,
      notes: dto.notes?.trim() || undefined,
      payment: {
        provider: 'jazzcash',
        status: PaymentStatus.PENDING,
        amountMinor,
        currency: 'PKR',
        txnRefNo,
        txnDateTime: this.formatJazzCashDateTime(now),
        txnExpiryDateTime: this.formatJazzCashDateTime(expiresAt),
        expiresAt,
        billReference: this.buildBillReference(String(new Types.ObjectId())),
        description: this.buildBookingDescription(
          typeof lawyerProfile.user === 'object' &&
            lawyerProfile.user !== null &&
            'name' in lawyerProfile.user
            ? String((lawyerProfile.user as { name?: string }).name || '')
            : '',
        ),
        initiatedAt: now,
      },
    });

    booking.payment.billReference = this.buildBillReference(
      String(booking._id),
    );

    const redirectToken = randomBytes(32).toString('hex');
    booking.payment.redirectTokenHash = this.hashValue(redirectToken);
    booking.payment.redirectTokenExpiresAt = expiresAt;

    await booking.save();

    return {
      bookingId: String(booking._id),
      redirectUrl: `${this.trimTrailingSlash(
        jazzCash.backendPublicUrl,
      )}/api/bookings/payments/jazzcash/redirect?bookingId=${encodeURIComponent(
        String(booking._id),
      )}&token=${encodeURIComponent(redirectToken)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async renderJazzCashRedirectForm(bookingId: string, token: string) {
    await this.expireStalePaymentReservations();

    if (!bookingId || !token) {
      return this.buildBrowserRedirectHtml(
        this.buildFrontendReturnUrl(undefined, 'invalid_checkout'),
      );
    }

    const booking = await this.bookingModel.findById(bookingId).lean();
    if (!booking) {
      return this.buildBrowserRedirectHtml(
        this.buildFrontendReturnUrl(undefined, 'unknown_booking'),
      );
    }

    const baseReturnUrl = this.buildFrontendReturnUrl(
      String(booking._id),
      'invalid_checkout',
    );

    if (
      booking.status !== BookingStatus.AWAITING_PAYMENT ||
      booking.payment?.status !== PaymentStatus.PENDING
    ) {
      return this.buildBrowserRedirectHtml(baseReturnUrl);
    }

    if (
      !booking.payment?.redirectTokenHash ||
      !booking.payment?.redirectTokenExpiresAt ||
      booking.payment.redirectTokenExpiresAt.getTime() < Date.now()
    ) {
      await this.markBookingPaymentExpired(booking._id);
      return this.buildBrowserRedirectHtml(
        this.buildFrontendReturnUrl(String(booking._id), 'expired'),
      );
    }

    const expectedHash = Buffer.from(booking.payment.redirectTokenHash, 'hex');
    const receivedHash = Buffer.from(this.hashValue(token), 'hex');
    if (
      expectedHash.length !== receivedHash.length ||
      !timingSafeEqual(expectedHash, receivedHash)
    ) {
      return this.buildBrowserRedirectHtml(baseReturnUrl);
    }

    const jazzCash = this.getJazzCashConfig();
    const payload = await this.buildJazzCashRequestPayload(booking, jazzCash);

    await this.bookingModel.updateOne(
      { _id: booking._id },
      {
        $unset: {
          'payment.redirectTokenHash': '',
          'payment.redirectTokenExpiresAt': '',
        },
      },
    );

    return this.buildJazzCashFormHtml(jazzCash.gatewayUrl, payload);
  }

  async handleJazzCashCallback(rawPayload: Record<string, unknown>) {
    await this.expireStalePaymentReservations();

    const payload = this.normalizeJazzCashPayload(rawPayload);
    const txnRefNo = payload.pp_TxnRefNo;
    if (!txnRefNo) {
      return {
        redirectUrl: this.buildFrontendReturnUrl(undefined, 'invalid_callback'),
      };
    }

    const booking = await this.bookingModel.findOne({
      'payment.txnRefNo': txnRefNo,
    });

    if (!booking) {
      return {
        redirectUrl: this.buildFrontendReturnUrl(
          undefined,
          'unknown_transaction',
        ),
      };
    }

    const redirectBase = this.buildFrontendReturnUrl(String(booking._id));
    if (booking.payment?.status === PaymentStatus.SUCCEEDED) {
      return { redirectUrl: `${redirectBase}&status=success` };
    }

    const jazzCash = this.getJazzCashConfig();
    const secureHashVerified = this.verifyJazzCashSecureHash(
      payload,
      jazzCash.integritySalt,
    );

    if (!secureHashVerified) {
      return { redirectUrl: `${redirectBase}&status=verification_failed` };
    }

    const payloadAmount = payload.pp_Amount;
    const payloadMerchantId = payload.pp_MerchantID;
    const bookingIdFromPayload = payload.ppmpf_1;
    const responseCode = payload.pp_ResponseCode || '';
    const responseMessage = payload.pp_ResponseMessage || 'No response message';
    const retrievalReferenceNo =
      payload.pp_RetreivalReferenceNo || payload.pp_RetrievalReferenceNo || '';
    const authCode = payload.pp_AuthCode || '';

    booking.payment.secureHashVerified = true;
    booking.payment.responseCode = responseCode;
    booking.payment.responseMessage = responseMessage;
    booking.payment.retrievalReferenceNo = retrievalReferenceNo;
    booking.payment.authCode = authCode;
    booking.payment.redirectTokenHash = undefined;
    booking.payment.redirectTokenExpiresAt = undefined;

    const bookingMatchesCallback =
      payloadMerchantId === jazzCash.merchantId &&
      payloadAmount === String(booking.payment.amountMinor) &&
      (!bookingIdFromPayload || bookingIdFromPayload === String(booking._id));

    if (!bookingMatchesCallback) {
      booking.payment.status = PaymentStatus.FAILED;
      booking.payment.failedAt = new Date();
      booking.payment.responseMessage =
        'JazzCash callback did not match the initiated booking values.';
      booking.status = BookingStatus.CANCELLED;
      await booking.save();

      return { redirectUrl: `${redirectBase}&status=validation_failed` };
    }

    if (this.isJazzCashSuccessCode(responseCode)) {
      booking.payment.status = PaymentStatus.SUCCEEDED;
      booking.payment.paidAt = new Date();
      booking.status = BookingStatus.PENDING;
      await booking.save();

      const lawyerProfile = await this.lawyerModel
        .findById(booking.lawyer)
        .select('user')
        .lean();

      if (lawyerProfile?.user) {
        await this.notificationService.notifyLawyer(
          String(lawyerProfile.user),
          'You have a new paid appointment request on Lawvera.',
        );
      }

      return { redirectUrl: `${redirectBase}&status=success` };
    }

    if (this.isJazzCashPendingCode(responseCode)) {
      booking.payment.status = PaymentStatus.PENDING;
      booking.status = BookingStatus.AWAITING_PAYMENT;
      await booking.save();

      return { redirectUrl: `${redirectBase}&status=pending` };
    }

    booking.payment.status = this.isJazzCashCancelledCode(responseCode)
      ? PaymentStatus.CANCELLED
      : PaymentStatus.FAILED;
    booking.payment.failedAt = new Date();
    booking.status = BookingStatus.CANCELLED;
    await booking.save();

    return { redirectUrl: `${redirectBase}&status=failed` };
  }

  async getPaymentStatus(bookingId: string, actor: CurrentActor) {
    await this.expireStalePaymentReservations();

    const booking = await this.bookingModel
      .findById(bookingId)
      .populate('client', 'name email city phone')
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name city specialization' },
      });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    await this.assertBookingAccess(booking, actor);
    return booking;
  }

  async getClientBookings(clientId: string) {
    await this.expireStalePaymentReservations();

    return this.bookingModel
      .find({ client: clientId })
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name city specialization' },
      })
      .sort({ slotDate: -1 });
  }

  async getLawyerBookings(lawyerUserId: string) {
    await this.expireStalePaymentReservations();

    const profile = await this.lawyerModel.findOne({ user: lawyerUserId });
    if (!profile) {
      throw new NotFoundException('Lawyer profile not found');
    }

    return this.bookingModel
      .find({
        lawyer: profile._id,
        status: { $ne: BookingStatus.AWAITING_PAYMENT },
      })
      .populate('client', 'name email city phone')
      .sort({ slotDate: -1 });
  }

  async getMyFinances(actor: CurrentActor) {
    await this.expireStalePaymentReservations();

    if (actor.role === UserRole.CLIENT) {
      const [bookings, cases] = await Promise.all([
        this.bookingModel
          .find({
            client: actor.userId,
            'payment.status': PaymentStatus.SUCCEEDED,
          })
          .populate({
            path: 'lawyer',
            select: 'specialization user',
            populate: { path: 'user', select: 'name email city phone' },
          })
          .sort({ 'payment.paidAt': -1, createdAt: -1 })
          .lean(),
        this.caseModel
          .find({
            client: actor.userId,
            'escrow.status': {
              $in: [
                CaseEscrowStatus.HELD,
                CaseEscrowStatus.RELEASE_PENDING,
                CaseEscrowStatus.RELEASED,
                CaseEscrowStatus.REFUND_PENDING,
                CaseEscrowStatus.REFUNDED,
              ],
            },
          })
          .populate({
            path: 'lawyer',
            select: 'specialization user',
            populate: { path: 'user', select: 'name email city phone' },
          })
          .sort({ 'escrow.capturedAt': -1, updatedAt: -1 })
          .lean(),
      ]);

      const bookingTransactions = bookings.map((booking) => {
        const lawyer = booking.lawyer as PopulatedLawyerSummary | undefined;
        return {
          id: String(booking._id),
          bookingId: String(booking._id),
          caseId: null,
          sourceType: 'booking' as const,
          title: booking.reason || 'Consultation booking',
          direction: 'paid' as const,
          counterparty: this.buildCounterpartySummary(lawyer?.user),
          lawyerSpecialization: lawyer?.specialization || null,
          amountMinor: booking.payment.amountMinor,
          currency: booking.payment.currency,
          provider: booking.payment.provider,
          paymentStatus: booking.payment.status,
          bookingStatus: booking.status,
          caseStatus: null,
          escrowStatus: null,
          txnRefNo: booking.payment.txnRefNo,
          paidAt: booking.payment.paidAt?.toISOString() || null,
          appointmentDate: booking.slotDate.toISOString(),
          slotTime: booking.slotTime,
          reason: booking.reason || null,
        } satisfies FinanceTransactionRecord;
      });

      const caseTransactions = cases.map((legalCase) => {
        const lawyer = legalCase.lawyer as PopulatedLawyerSummary | undefined;
        return {
          id: String(legalCase._id),
          bookingId: null,
          caseId: String(legalCase._id),
          sourceType: 'case' as const,
          title: legalCase.title,
          direction: 'paid' as const,
          counterparty: this.buildCounterpartySummary(lawyer?.user),
          lawyerSpecialization: lawyer?.specialization || null,
          amountMinor: legalCase.escrow?.amountMinor || 0,
          currency: legalCase.escrow?.currency || 'USD',
          provider: legalCase.escrow?.provider || 'paypal',
          paymentStatus:
            legalCase.escrow?.status === CaseEscrowStatus.REFUNDED
              ? 'refunded'
              : 'succeeded',
          bookingStatus: null,
          caseStatus: legalCase.status,
          escrowStatus: legalCase.escrow?.status || null,
          txnRefNo:
            legalCase.escrow?.paypalCaptureId ||
            legalCase.escrow?.paypalOrderId ||
            legalCase.escrow?.invoiceId ||
            'n/a',
          paidAt:
            legalCase.escrow?.capturedAt?.toISOString() ||
            legalCase.escrow?.approvedAt?.toISOString() ||
            null,
          appointmentDate: null,
          slotTime: null,
          reason: legalCase.description || null,
        } satisfies FinanceTransactionRecord;
      });

      return this.buildFinanceResponse('client', [
        ...bookingTransactions,
        ...caseTransactions,
      ]);
    }

    if (actor.role === UserRole.LAWYER) {
      const profile = await this.lawyerModel.findOne({ user: actor.userId });
      if (!profile) {
        throw new NotFoundException('Lawyer profile not found');
      }

      const [bookings, cases] = await Promise.all([
        this.bookingModel
          .find({
            lawyer: profile._id,
            'payment.status': PaymentStatus.SUCCEEDED,
          })
          .populate('client', 'name email city phone')
          .sort({ 'payment.paidAt': -1, createdAt: -1 })
          .lean(),
        this.caseModel
          .find({
            lawyer: profile._id,
            'escrow.status': CaseEscrowStatus.RELEASED,
          })
          .populate('client', 'name email city phone')
          .sort({ 'escrow.releasedAt': -1, updatedAt: -1 })
          .lean(),
      ]);

      const bookingTransactions = bookings.map((booking) => ({
        id: String(booking._id),
        bookingId: String(booking._id),
        caseId: null,
        sourceType: 'booking' as const,
        title: booking.reason || 'Consultation booking',
        direction: 'received' as const,
        counterparty: this.buildCounterpartySummary(
          booking.client as PopulatedUserSummary,
        ),
        lawyerSpecialization: profile.specialization || null,
        amountMinor: booking.payment.amountMinor,
        currency: booking.payment.currency,
        provider: booking.payment.provider,
        paymentStatus: booking.payment.status,
        bookingStatus: booking.status,
        caseStatus: null,
        escrowStatus: null,
        txnRefNo: booking.payment.txnRefNo,
        paidAt: booking.payment.paidAt?.toISOString() || null,
        appointmentDate: booking.slotDate.toISOString(),
        slotTime: booking.slotTime,
        reason: booking.reason || null,
      } satisfies FinanceTransactionRecord));

      const caseTransactions = cases.map((legalCase) => ({
        id: String(legalCase._id),
        bookingId: null,
        caseId: String(legalCase._id),
        sourceType: 'case' as const,
        title: legalCase.title,
        direction: 'received' as const,
        counterparty: this.buildCounterpartySummary(
          legalCase.client as PopulatedUserSummary,
        ),
        lawyerSpecialization: profile.specialization || null,
        amountMinor: legalCase.escrow?.lawyerAmountMinor || 0,
        currency: legalCase.escrow?.currency || 'USD',
        provider: legalCase.escrow?.provider || 'paypal',
        paymentStatus: 'succeeded',
        bookingStatus: null,
        caseStatus: legalCase.status,
        escrowStatus: legalCase.escrow?.status || null,
        txnRefNo:
          legalCase.escrow?.paypalPayoutBatchId ||
          legalCase.escrow?.paypalPayoutItemId ||
          legalCase.escrow?.paypalCaptureId ||
          'n/a',
        paidAt: legalCase.escrow?.releasedAt?.toISOString() || null,
        appointmentDate: null,
        slotTime: null,
        reason: legalCase.description || null,
      } satisfies FinanceTransactionRecord));

      return this.buildFinanceResponse('lawyer', [
        ...bookingTransactions,
        ...caseTransactions,
      ]);
    }

    throw new UnauthorizedException();
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

    if (
      booking.status === BookingStatus.AWAITING_PAYMENT ||
      booking.payment?.status !== PaymentStatus.SUCCEEDED
    ) {
      throw new BadRequestException(
        'Only paid bookings can be updated by a lawyer or admin.',
      );
    }

    if (dto.status === BookingStatus.AWAITING_PAYMENT) {
      throw new BadRequestException('Invalid booking status transition.');
    }

    if (actor.role === UserRole.LAWYER) {
      const lawyerProfile = await this.lawyerModel.findOne({
        user: actor.userId,
      });
      const bookingLawyerId =
        typeof booking.lawyer === 'object' &&
        booking.lawyer !== null &&
        '_id' in (booking.lawyer as object)
          ? String((booking.lawyer as { _id: Types.ObjectId })._id)
          : String(booking.lawyer);

      if (!lawyerProfile || bookingLawyerId !== lawyerProfile._id.toString()) {
        throw new UnauthorizedException();
      }
    } else if (!isAdminRole(actor.role)) {
      throw new UnauthorizedException();
    }

    const lawyerRef =
      typeof booking.lawyer === 'object' &&
      booking.lawyer !== null &&
      '_id' in (booking.lawyer as object)
        ? (booking.lawyer as { _id: Types.ObjectId })._id
        : booking.lawyer;

    const lawyerProfileDoc = await this.lawyerModel.findById(lawyerRef);

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

  async updateMeetingLink(
    bookingId: string,
    dto: UpdateBookingMeetingLinkDto,
    actor: { userId: string; role: UserRole },
  ) {
    const booking = await this.bookingModel
      .findById(bookingId)
      .populate('client', 'name email')
      .populate({
        path: 'lawyer',
        select: 'user',
        populate: { path: 'user', select: 'name email' },
      });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (
      booking.status === BookingStatus.AWAITING_PAYMENT ||
      booking.status === BookingStatus.CANCELLED ||
      booking.payment?.status !== PaymentStatus.SUCCEEDED
    ) {
      throw new BadRequestException(
        'Meeting links can only be added to paid active bookings.',
      );
    }

    if (booking.status === BookingStatus.COMPLETED) {
      throw new BadRequestException(
        'Meeting links cannot be changed after the appointment is completed.',
      );
    }

    if (actor.role === UserRole.LAWYER) {
      const lawyerProfile = await this.lawyerModel.findOne({
        user: actor.userId,
      });
      const bookingLawyerId =
        typeof booking.lawyer === 'object' &&
        booking.lawyer !== null &&
        '_id' in (booking.lawyer as object)
          ? String((booking.lawyer as { _id: Types.ObjectId })._id)
          : String(booking.lawyer);

      if (!lawyerProfile || bookingLawyerId !== lawyerProfile._id.toString()) {
        throw new UnauthorizedException();
      }
    } else if (!isAdminRole(actor.role)) {
      throw new UnauthorizedException();
    }

    booking.meetingLink = dto.meetingLink.trim();
    await booking.save();

    const client =
      typeof booking.client === 'object' && booking.client !== null
        ? (booking.client as {
            name?: string;
            email?: string;
            _id?: Types.ObjectId;
          })
        : null;
    const lawyerProfile =
      typeof booking.lawyer === 'object' && booking.lawyer !== null
        ? (booking.lawyer as {
            user?: { name?: string; email?: string; _id?: Types.ObjectId };
          })
        : null;
    const lawyerUser = lawyerProfile?.user;

    if (client?.email) {
      await this.notificationService.sendBookingMeetingLinkEmail({
        clientEmail: client.email,
        clientName: client.name || 'Client',
        lawyerName: lawyerUser?.name || 'Your lawyer',
        meetingLink: booking.meetingLink,
        slotDate: booking.slotDate,
        slotTime: booking.slotTime,
      });
    }

    if (client?._id) {
      await this.notificationService.notifyClient(
        String(client._id),
        'Your lawyer has shared a meeting link for your appointment.',
      );
    }

    return booking;
  }

  async cancelBooking(bookingId: string, actorUserId: string, role: UserRole) {
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

    const previouslyPaid = booking.payment?.status === PaymentStatus.SUCCEEDED;

    booking.status = BookingStatus.CANCELLED;
    booking.payment.status = PaymentStatus.CANCELLED;
    booking.payment.responseMessage =
      booking.payment.responseMessage || 'Cancelled';
    booking.payment.failedAt = booking.payment.failedAt || new Date();
    booking.payment.redirectTokenHash = undefined;
    booking.payment.redirectTokenExpiresAt = undefined;
    await booking.save();

    if (previouslyPaid) {
      const lawyerProfile = await this.lawyerModel.findById(booking.lawyer);
      if (lawyerProfile) {
        await this.notificationService.notifyLawyer(
          lawyerProfile.user.toString(),
          'A booking has been cancelled.',
        );
      }
    }

    return booking;
  }

  async adminBookings() {
    await this.expireStalePaymentReservations();

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
    await this.expireStalePaymentReservations();

    const [total, confirmed, today] = await Promise.all([
      this.bookingModel.countDocuments({
        status: { $ne: BookingStatus.AWAITING_PAYMENT },
      }),
      this.bookingModel.countDocuments({ status: BookingStatus.CONFIRMED }),
      this.bookingModel.countDocuments({
        status: { $ne: BookingStatus.AWAITING_PAYMENT },
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

  private async assertBookingAccess(
    booking: BookingDocument,
    actor: CurrentActor,
  ) {
    if (isAdminRole(actor.role)) {
      return;
    }

    if (actor.role === UserRole.CLIENT) {
      if (booking.client.toString() !== actor.userId) {
        throw new UnauthorizedException();
      }
      return;
    }

    if (actor.role === UserRole.LAWYER) {
      const profile = await this.lawyerModel.findOne({ user: actor.userId });
      if (!profile || booking.lawyer.toString() !== profile._id.toString()) {
        throw new UnauthorizedException();
      }
      return;
    }

    throw new UnauthorizedException();
  }

  private buildFinanceResponse(
    role: 'client' | 'lawyer',
    transactions: FinanceTransactionRecord[],
  ) {
    const sortedTransactions = [...transactions].sort((left, right) => {
      const leftDate = left.paidAt ? new Date(left.paidAt).getTime() : 0;
      const rightDate = right.paidAt ? new Date(right.paidAt).getTime() : 0;
      return rightDate - leftDate;
    });
    const totalAmountMinor = transactions.reduce(
      (sum, transaction) => sum + transaction.amountMinor,
      0,
    );

    return {
      role,
      summary: {
        totalTransactions: transactions.length,
        totalAmountMinor,
        currency: sortedTransactions[0]?.currency || 'PKR',
      },
      transactions: sortedTransactions,
    };
  }

  private buildCounterpartySummary(user?: PopulatedUserSummary) {
    return {
      id: user?._id ? String(user._id) : null,
      name: user?.name || 'Unknown user',
      email: user?.email || null,
      phone: user?.phone || null,
      city: user?.city || null,
    };
  }

  private async ensureSlotAvailable(
    lawyerId: Types.ObjectId,
    slotDate: Date,
    slotTime: string,
  ) {
    const now = new Date();
    const existingBooking = await this.bookingModel.exists({
      lawyer: lawyerId,
      slotDate,
      slotTime,
      $or: [
        { status: { $in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] } },
        {
          status: BookingStatus.AWAITING_PAYMENT,
          'payment.status': PaymentStatus.PENDING,
          'payment.expiresAt': { $gt: now },
        },
      ],
    });

    if (existingBooking) {
      throw new BadRequestException('This time slot is no longer available.');
    }
  }

  private assertSlotMatchesAvailability(
    lawyerProfile: LawyerProfile & {
      availability?: Array<{ day: string; slots: string[] }>;
    },
    slotDate: Date,
    slotTime: string,
  ) {
    const dayName = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: 'Asia/Karachi',
    }).format(slotDate);
    const availableDay = lawyerProfile.availability?.find(
      (slot) => slot.day === dayName,
    );

    if (!availableDay || !availableDay.slots.includes(slotTime)) {
      throw new BadRequestException(
        'The selected time does not exist in the lawyer availability.',
      );
    }
  }

  private normalizeConsultationFee(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(
        'This lawyer has an invalid consultation fee.',
      );
    }

    return Math.round(value * 100) / 100;
  }

  private generateTxnRefNo(now: Date) {
    const prefix = 'LV';
    const stamp = this.formatJazzCashDateTime(now);
    const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
    return `${prefix}${stamp}${randomSuffix}`;
  }

  private buildBillReference(bookingId: string) {
    return `BKG${bookingId.replace(/[^a-zA-Z0-9]/g, '').slice(-17)}`;
  }

  private buildBookingDescription(lawyerName: string) {
    const fallback = 'Lawvera legal consultation';
    const description = lawyerName
      ? `Lawvera consultation with ${lawyerName}`.trim()
      : fallback;
    return description.slice(0, 100);
  }

  private async buildJazzCashRequestPayload(
    booking: BookingDocument | (Booking & { _id: Types.ObjectId }),
    config: JazzCashConfig,
  ) {
    Jazzcash.credentials({
      config: {
        merchantId: config.merchantId,
        password: config.password,
        hashKey: config.integritySalt,
      },
      environment: 'sandbox',
    });

    Jazzcash.setData({
      pp_Version: '1.1',
      pp_TxnType: config.txnType,
      pp_Language: config.language,
      pp_TxnRefNo: booking.payment.txnRefNo,
      pp_Amount: booking.payment.amountMinor / 100,
      pp_TxnCurrency: booking.payment.currency,
      pp_TxnDateTime: booking.payment.txnDateTime,
      pp_BillReference: booking.payment.billReference || '',
      pp_Description: booking.payment.description || 'Lawvera consultation',
      pp_TxnExpiryDateTime: booking.payment.txnExpiryDateTime,
      pp_ReturnURL: `${this.trimTrailingSlash(
        config.backendPublicUrl,
      )}/api/bookings/payments/jazzcash/callback`,
      ppmpf_1: String(booking._id),
    });

    const payload = await Jazzcash.createRequest('PAY');

    return Object.entries(payload).reduce<Record<string, string>>(
      (accumulator, [key, value]) => {
        accumulator[key] =
          key === 'pp_SecureHash' ? String(value).toUpperCase() : String(value);
        return accumulator;
      },
      {},
    );
  }

  private normalizeJazzCashPayload(rawPayload: Record<string, unknown>) {
    return Object.entries(rawPayload).reduce<Record<string, string>>(
      (accumulator, [key, value]) => {
        const normalized = this.pickFirstString(value);
        if (normalized !== undefined) {
          accumulator[key] = normalized;
        }
        return accumulator;
      },
      {},
    );
  }

  private pickFirstString(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value)) {
      const firstString = value.find((item) => typeof item === 'string');
      return typeof firstString === 'string' ? firstString : undefined;
    }

    return undefined;
  }

  private verifyJazzCashSecureHash(
    payload: Record<string, string>,
    integritySalt: string,
  ) {
    const receivedSecureHash = payload.pp_SecureHash;
    if (!receivedSecureHash) {
      return false;
    }

    const expectedSecureHash = this.computeJazzCashSecureHash(
      payload,
      integritySalt,
    );

    const expected = Buffer.from(expectedSecureHash.toLowerCase(), 'utf8');
    const received = Buffer.from(receivedSecureHash.toLowerCase(), 'utf8');

    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  }

  private computeJazzCashSecureHash(
    payload: Record<string, string>,
    integritySalt: string,
  ) {
    const sortedValues = Object.keys(payload)
      .filter((key) => key.startsWith('pp_') && key !== 'pp_SecureHash')
      .sort()
      .map((key) => payload[key])
      .filter((value) => value !== undefined && value !== null && value !== '');

    const data = [integritySalt, ...sortedValues].join('&');

    return createHmac('sha256', integritySalt)
      .update(data, 'utf8')
      .digest('hex')
      .toUpperCase();
  }

  private async expireStalePaymentReservations() {
    const now = new Date();

    await this.bookingModel.updateMany(
      {
        status: BookingStatus.AWAITING_PAYMENT,
        'payment.status': PaymentStatus.PENDING,
        'payment.expiresAt': { $lte: now },
      },
      {
        $set: {
          status: BookingStatus.CANCELLED,
          'payment.status': PaymentStatus.EXPIRED,
          'payment.failedAt': now,
          'payment.responseMessage': 'Payment window expired.',
        },
        $unset: {
          'payment.redirectTokenHash': '',
          'payment.redirectTokenExpiresAt': '',
        },
      },
    );
  }

  private async markBookingPaymentExpired(bookingId: Types.ObjectId) {
    await this.bookingModel.updateOne(
      { _id: bookingId },
      {
        $set: {
          status: BookingStatus.CANCELLED,
          'payment.status': PaymentStatus.EXPIRED,
          'payment.failedAt': new Date(),
          'payment.responseMessage': 'Payment window expired.',
        },
        $unset: {
          'payment.redirectTokenHash': '',
          'payment.redirectTokenExpiresAt': '',
        },
      },
    );
  }

  private isJazzCashSuccessCode(responseCode: string) {
    return responseCode === '000';
  }

  private isJazzCashPendingCode(responseCode: string) {
    return responseCode === '124' || responseCode === '157';
  }

  private isJazzCashCancelledCode(responseCode: string) {
    return responseCode === '110' || responseCode === '156';
  }

  private buildJazzCashFormHtml(
    actionUrl: string,
    fields: Record<string, string>,
  ) {
    const inputs = Object.entries(fields)
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${this.escapeHtml(
            name,
          )}" value="${this.escapeHtml(value)}" />`,
      )
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Cache-Control" content="no-store" />
    <title>Redirecting to JazzCash</title>
  </head>
  <body>
    <form id="jazzcash-payment-form" method="post" action="${this.escapeHtml(
      actionUrl,
    )}">
      ${inputs}
    </form>
    <script>
      document.getElementById('jazzcash-payment-form').submit();
    </script>
    <noscript>
      <p>Continue to JazzCash to complete your payment.</p>
      <button type="submit" form="jazzcash-payment-form">Continue</button>
    </noscript>
  </body>
</html>`;
  }

  private buildBrowserRedirectHtml(url: string) {
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0;url=${this.escapeHtml(url)}" />
    <title>Redirecting</title>
  </head>
  <body>
    <script>
      window.location.replace(${JSON.stringify(url)});
    </script>
    <p>Redirecting...</p>
  </body>
</html>`;
  }

  private buildFrontendReturnUrl(bookingId?: string, status?: string) {
    const url = new URL(
      `${this.trimTrailingSlash(
        this.getJazzCashConfig().frontendAppUrl,
      )}/payments/jazzcash/return`,
    );

    if (bookingId) {
      url.searchParams.set('bookingId', bookingId);
    }

    if (status) {
      url.searchParams.set('status', status);
    }

    return url.toString();
  }

  private formatJazzCashDateTime(date: Date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

    const getPart = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value || '';

    return `${getPart('year')}${getPart('month')}${getPart('day')}${getPart(
      'hour',
    )}${getPart('minute')}${getPart('second')}`;
  }

  private hashValue(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private trimTrailingSlash(value: string) {
    return value.replace(/\/+$/, '');
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private getJazzCashConfig(): JazzCashConfig {
    const backendPublicUrl =
      this.configService.get<string>('BACKEND_PUBLIC_URL');
    const frontendAppUrl = this.configService.get<string>('FRONTEND_APP_URL');
    const merchantId = this.configService.get<string>('JAZZCASH_MERCHANT_ID');
    const password = this.configService.get<string>('JAZZCASH_PASSWORD');
    const integritySalt = this.configService.get<string>(
      'JAZZCASH_INTEGRITY_SALT',
    );
    const gatewayUrl = this.configService.get<string>('JAZZCASH_GATEWAY_URL');

    if (
      !backendPublicUrl ||
      !frontendAppUrl ||
      !merchantId ||
      !password ||
      !integritySalt ||
      !gatewayUrl
    ) {
      throw new InternalServerErrorException(
        'JazzCash payment gateway is not configured correctly.',
      );
    }

    return {
      backendPublicUrl,
      frontendAppUrl,
      merchantId,
      password,
      integritySalt,
      gatewayUrl,
      language: this.configService.get<string>('JAZZCASH_LANGUAGE', 'EN'),
      txnType: this.configService.get<string>('JAZZCASH_TXN_TYPE', 'MWALLET'),
      paymentWindowMinutes: Number(
        this.configService.get<string>(
          'JAZZCASH_PAYMENT_WINDOW_MINUTES',
          String(BookingService.DEFAULT_PAYMENT_WINDOW_MINUTES),
        ),
      ),
    };
  }
}
