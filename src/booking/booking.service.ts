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
  FinanceTransaction,
  FinanceTransactionDocument,
} from './schemas/finance-transaction.schema';
import {
  LawyerProfile,
  LawyerProfileDocument,
} from '../lawyer/schemas/lawyer-profile.schema';
import { User, UserDocument } from '../user/schemas/user.schema';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BookingStatus } from '../common/enums/booking-status.enum';
import { UpdateBookingStatusDto } from './dto/update-booking-status.dto';
import { NotificationService } from '../common/services/notification.service';
import { LawyerStatus } from '../common/enums/lawyer-status.enum';
import { UserRole } from '../common/enums/role.enum';
import { PaymentStatus } from '../common/enums/payment-status.enum';

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

type FinanceBookingRecord = Booking & {
  _id: Types.ObjectId;
  client: Types.ObjectId | PopulatedUserSummary;
  lawyer: Types.ObjectId | PopulatedLawyerSummary;
  createdAt?: Date;
  updatedAt?: Date;
};

type StoredFinanceTransaction = FinanceTransaction & {
  _id: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
};

@Injectable()
export class BookingService {
  private static readonly DEFAULT_PAYMENT_WINDOW_MINUTES = 15;

  constructor(
    @InjectModel(Booking.name)
    private readonly bookingModel: Model<BookingDocument>,
    @InjectModel(FinanceTransaction.name)
    private readonly financeTransactionModel: Model<FinanceTransactionDocument>,
    @InjectModel(LawyerProfile.name)
    private readonly lawyerModel: Model<LawyerProfileDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
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

    booking.payment.billReference = this.buildBillReference(String(booking._id));

    const redirectToken = randomBytes(32).toString('hex');
    booking.payment.redirectTokenHash = this.hashValue(redirectToken);
    booking.payment.redirectTokenExpiresAt = expiresAt;

    await booking.save();
    await this.syncFinanceTransactionForBookingId(booking._id);

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
        redirectUrl: this.buildFrontendReturnUrl(undefined, 'unknown_transaction'),
      };
    }

    const redirectBase = this.buildFrontendReturnUrl(String(booking._id));
    if (booking.payment?.status === PaymentStatus.SUCCEEDED) {
      await this.syncFinanceTransactionForBookingId(booking._id);
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
      await this.syncFinanceTransactionForBookingId(booking._id, payload);

      return { redirectUrl: `${redirectBase}&status=validation_failed` };
    }

    if (this.isJazzCashSuccessCode(responseCode)) {
      booking.payment.status = PaymentStatus.SUCCEEDED;
      booking.payment.paidAt = new Date();
      booking.status = BookingStatus.PENDING;
      await booking.save();
      await this.syncFinanceTransactionForBookingId(booking._id, payload);

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
      await this.syncFinanceTransactionForBookingId(booking._id, payload);

      return { redirectUrl: `${redirectBase}&status=pending` };
    }

    booking.payment.status = this.isJazzCashCancelledCode(responseCode)
      ? PaymentStatus.CANCELLED
      : PaymentStatus.FAILED;
    booking.payment.failedAt = new Date();
    booking.status = BookingStatus.CANCELLED;
    await booking.save();
    await this.syncFinanceTransactionForBookingId(booking._id, payload);

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
      await this.backfillFinanceTransactions({
        client: new Types.ObjectId(actor.userId),
      });

      const transactions = await this.financeTransactionModel
        .find({
          client: actor.userId,
          paymentStatus: PaymentStatus.SUCCEEDED,
        })
        .sort({ paidAt: -1, createdAt: -1 })
        .lean();

      return this.buildFinanceResponse(
        'client',
        transactions.map((transaction) =>
          this.mapFinanceTransactionForViewer(transaction, 'client'),
        ),
      );
    }

    if (actor.role === UserRole.LAWYER) {
      const profile = await this.lawyerModel.findOne({ user: actor.userId });
      if (!profile) {
        throw new NotFoundException('Lawyer profile not found');
      }

      await this.backfillFinanceTransactions({ lawyer: profile._id });

      const transactions = await this.financeTransactionModel
        .find({
          lawyerUser: actor.userId,
          paymentStatus: PaymentStatus.SUCCEEDED,
        })
        .sort({ paidAt: -1, createdAt: -1 })
        .lean();

      return this.buildFinanceResponse(
        'lawyer',
        transactions.map((transaction) =>
          this.mapFinanceTransactionForViewer(transaction, 'lawyer'),
        ),
      );
    }

    throw new UnauthorizedException();
  }

  async getAdminFinances() {
    await this.expireStalePaymentReservations();
    await this.backfillFinanceTransactions();

    const transactions = await this.financeTransactionModel
      .find()
      .sort({ paidAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    return this.buildAdminFinanceResponse(
      transactions.map((transaction) =>
        this.mapFinanceTransactionForAdmin(transaction),
      ),
    );
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
    } else if (actor.role !== UserRole.ADMIN) {
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
    await this.syncFinanceTransactionForBookingId(booking._id);

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

    const previouslyPaid = booking.payment?.status === PaymentStatus.SUCCEEDED;

    booking.status = BookingStatus.CANCELLED;
    if (!previouslyPaid) {
      booking.payment.status = PaymentStatus.CANCELLED;
      booking.payment.failedAt = booking.payment.failedAt || new Date();
    }
    booking.payment.responseMessage = booking.payment.responseMessage || 'Cancelled';
    booking.payment.redirectTokenHash = undefined;
    booking.payment.redirectTokenExpiresAt = undefined;
    await booking.save();
    await this.syncFinanceTransactionForBookingId(booking._id);

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

  private async assertBookingAccess(booking: BookingDocument, actor: CurrentActor) {
    if (actor.role === UserRole.ADMIN) {
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
    transactions: Array<{
      amountMinor: number;
      currency: string;
      paymentStatus: PaymentStatus;
      [key: string]: unknown;
    }>,
  ) {
    return {
      role,
      summary: this.buildFinanceSummary(transactions),
      transactions,
    };
  }

  private buildAdminFinanceResponse(
    transactions: Array<{
      amountMinor: number;
      currency: string;
      paymentStatus: PaymentStatus;
      [key: string]: unknown;
    }>,
  ) {
    return {
      role: 'admin' as const,
      summary: this.buildFinanceSummary(transactions),
      transactions,
    };
  }

  private buildFinanceSummary(
    transactions: Array<{
      amountMinor: number;
      currency: string;
      paymentStatus: PaymentStatus;
    }>,
  ) {
    const summary = {
      totalTransactions: transactions.length,
      totalAmountMinor: 0,
      currency: transactions[0]?.currency || 'PKR',
      succeededTransactions: 0,
      pendingTransactions: 0,
      failedTransactions: 0,
      cancelledTransactions: 0,
      expiredTransactions: 0,
    };

    for (const transaction of transactions) {
      if (transaction.paymentStatus === PaymentStatus.SUCCEEDED) {
        summary.totalAmountMinor += transaction.amountMinor;
        summary.succeededTransactions += 1;
        continue;
      }

      if (transaction.paymentStatus === PaymentStatus.PENDING) {
        summary.pendingTransactions += 1;
        continue;
      }

      if (transaction.paymentStatus === PaymentStatus.FAILED) {
        summary.failedTransactions += 1;
        continue;
      }

      if (transaction.paymentStatus === PaymentStatus.CANCELLED) {
        summary.cancelledTransactions += 1;
        continue;
      }

      if (transaction.paymentStatus === PaymentStatus.EXPIRED) {
        summary.expiredTransactions += 1;
      }
    }

    return summary;
  }

  private mapFinanceTransactionForViewer(
    transaction: StoredFinanceTransaction,
    role: 'client' | 'lawyer',
  ) {
    const client = this.buildParticipantSummary(transaction.clientSnapshot);
    const lawyer = this.buildParticipantSummary(transaction.lawyerSnapshot);

    return {
      id: String(transaction._id),
      bookingId: String(transaction.booking),
      direction: role === 'client' ? ('paid' as const) : ('received' as const),
      counterparty: role === 'client' ? lawyer : client,
      lawyerSpecialization: transaction.lawyerSnapshot?.specialization || null,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      provider: transaction.provider,
      paymentStatus: transaction.paymentStatus,
      bookingStatus: transaction.bookingStatus,
      txnRefNo: transaction.txnRefNo,
      receiptNumber: transaction.receiptNumber,
      paidAt: this.serializeDate(transaction.paidAt),
      initiatedAt: this.serializeDate(transaction.initiatedAt),
      failedAt: this.serializeDate(transaction.failedAt),
      appointmentDate: this.serializeDate(transaction.appointmentDate),
      slotTime: transaction.slotTime,
      reason: transaction.reason || null,
      responseMessage: transaction.responseMessage || null,
    };
  }

  private mapFinanceTransactionForAdmin(transaction: StoredFinanceTransaction) {
    const lawyer = this.buildParticipantSummary(transaction.lawyerSnapshot);

    return {
      id: String(transaction._id),
      bookingId: String(transaction.booking),
      client: this.buildParticipantSummary(transaction.clientSnapshot),
      lawyer: {
        ...lawyer,
        specialization: transaction.lawyerSnapshot?.specialization || null,
      },
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      provider: transaction.provider,
      paymentStatus: transaction.paymentStatus,
      bookingStatus: transaction.bookingStatus,
      txnRefNo: transaction.txnRefNo,
      receiptNumber: transaction.receiptNumber,
      paidAt: this.serializeDate(transaction.paidAt),
      initiatedAt: this.serializeDate(transaction.initiatedAt),
      failedAt: this.serializeDate(transaction.failedAt),
      appointmentDate: this.serializeDate(transaction.appointmentDate),
      slotTime: transaction.slotTime,
      reason: transaction.reason || null,
      responseMessage: transaction.responseMessage || null,
    };
  }

  private buildParticipantSummary(user?: {
    userId?: Types.ObjectId;
    name?: string;
    email?: string;
    phone?: string;
    city?: string;
  }) {
    return {
      id: user?.userId ? String(user.userId) : null,
      name: user?.name || 'Unknown user',
      email: user?.email || null,
      phone: user?.phone || null,
      city: user?.city || null,
    };
  }

  private buildParticipantSnapshot(
    user: PopulatedUserSummary,
    specialization?: string,
  ) {
    return {
      userId: user?._id ? this.toObjectId(user._id) : undefined,
      name: user?.name || 'Unknown user',
      email: user?.email || undefined,
      phone: user?.phone || undefined,
      city: user?.city || undefined,
      specialization: specialization || undefined,
    };
  }

  private serializeDate(value?: Date | null) {
    return value instanceof Date ? value.toISOString() : null;
  }

  private async backfillFinanceTransactions(filters: Record<string, unknown> = {}) {
    const bookings = (await this.bookingModel
      .find({
        ...filters,
        'payment.txnRefNo': { $exists: true, $ne: '' },
      })
      .populate('client', 'name email city phone')
      .populate({
        path: 'lawyer',
        select: 'specialization user',
        populate: { path: 'user', select: 'name email city phone' },
      })
      .lean()) as FinanceBookingRecord[];

    for (const booking of bookings) {
      await this.syncFinanceTransactionForBooking(booking);
    }
  }

  private async syncFinanceTransactionForBookingId(
    bookingId: Types.ObjectId | string,
    lastCallbackPayload?: Record<string, unknown>,
  ) {
    const booking = (await this.bookingModel
      .findById(bookingId)
      .populate('client', 'name email city phone')
      .populate({
        path: 'lawyer',
        select: 'specialization user',
        populate: { path: 'user', select: 'name email city phone' },
      })
      .lean()) as FinanceBookingRecord | null;

    if (!booking) {
      return;
    }

    await this.syncFinanceTransactionForBooking(booking, lastCallbackPayload);
  }

  private async syncFinanceTransactionForBooking(
    booking: FinanceBookingRecord,
    lastCallbackPayload?: Record<string, unknown>,
  ) {
    if (!booking.payment?.txnRefNo) {
      return;
    }

    const clientSource =
      this.extractPopulatedUser(booking.client) ||
      (await this.userModel
        .findById(booking.client)
        .select('name email city phone')
        .lean());

    const lawyerSource =
      this.extractPopulatedLawyer(booking.lawyer) ||
      ((await this.lawyerModel
        .findById(booking.lawyer)
        .populate('user', 'name email city phone')
        .select('specialization user')
        .lean()) as PopulatedLawyerSummary | null);

    const lawyerUser = this.extractPopulatedUser(lawyerSource?.user);

    if (!clientSource?._id || !lawyerSource?._id || !lawyerUser?._id) {
      return;
    }

    const update: Record<string, unknown> = {
      booking: this.toObjectId(booking._id),
      client: this.toObjectId(clientSource._id),
      lawyerProfile: this.toObjectId(lawyerSource._id),
      lawyerUser: this.toObjectId(lawyerUser._id),
      clientSnapshot: this.buildParticipantSnapshot(clientSource),
      lawyerSnapshot: this.buildParticipantSnapshot(
        lawyerUser,
        lawyerSource.specialization,
      ),
      amountMinor: booking.payment.amountMinor,
      currency: booking.payment.currency,
      provider: booking.payment.provider,
      paymentStatus: booking.payment.status,
      bookingStatus: booking.status,
      txnRefNo: booking.payment.txnRefNo,
      receiptNumber: this.buildReceiptNumber(booking.payment.txnRefNo),
      txnDateTime: booking.payment.txnDateTime,
      txnExpiryDateTime: booking.payment.txnExpiryDateTime,
      billReference: booking.payment.billReference,
      description: booking.payment.description,
      secureHashVerified: booking.payment.secureHashVerified,
      responseCode: booking.payment.responseCode,
      responseMessage: booking.payment.responseMessage,
      retrievalReferenceNo: booking.payment.retrievalReferenceNo,
      authCode: booking.payment.authCode,
      initiatedAt: booking.payment.initiatedAt,
      paidAt: booking.payment.paidAt,
      failedAt: booking.payment.failedAt,
      appointmentDate: booking.slotDate,
      slotTime: booking.slotTime,
      reason: booking.reason,
      notes: booking.notes,
      lastSyncedAt: new Date(),
    };

    if (lastCallbackPayload) {
      update.lastCallbackPayload = lastCallbackPayload;
    }

    await this.financeTransactionModel.findOneAndUpdate(
      { booking: booking._id },
      { $set: update },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    );
  }

  private extractPopulatedUser(
    value?: Types.ObjectId | string | PopulatedUserSummary,
  ) {
    if (
      !value ||
      typeof value === 'string' ||
      value instanceof Types.ObjectId ||
      !('name' in value || 'email' in value || 'phone' in value || 'city' in value)
    ) {
      return undefined;
    }

    return value as PopulatedUserSummary;
  }

  private extractPopulatedLawyer(
    value?: Types.ObjectId | string | PopulatedLawyerSummary,
  ) {
    if (
      !value ||
      typeof value === 'string' ||
      value instanceof Types.ObjectId ||
      !('user' in value || 'specialization' in value)
    ) {
      return undefined;
    }

    return value as PopulatedLawyerSummary;
  }

  private toObjectId(value: Types.ObjectId | string) {
    return value instanceof Types.ObjectId ? value : new Types.ObjectId(value);
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
    lawyerProfile: LawyerProfile & { availability?: Array<{ day: string; slots: string[] }> },
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
      throw new BadRequestException('This lawyer has an invalid consultation fee.');
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

  private buildReceiptNumber(txnRefNo: string) {
    return `RCT-${txnRefNo}`;
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
      expected.length === received.length &&
      timingSafeEqual(expected, received)
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
    const staleBookings = await this.bookingModel
      .find({
        status: BookingStatus.AWAITING_PAYMENT,
        'payment.status': PaymentStatus.PENDING,
        'payment.expiresAt': { $lte: now },
      })
      .select('_id')
      .lean();

    if (staleBookings.length === 0) {
      return;
    }

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

    for (const booking of staleBookings) {
      await this.syncFinanceTransactionForBookingId(booking._id);
    }
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
    await this.syncFinanceTransactionForBookingId(bookingId);
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
    const backendPublicUrl = this.configService.get<string>('BACKEND_PUBLIC_URL');
    const frontendAppUrl = this.configService.get<string>('FRONTEND_APP_URL');
    const merchantId = this.configService.get<string>('JAZZCASH_MERCHANT_ID');
    const password = this.configService.get<string>('JAZZCASH_PASSWORD');
    const integritySalt = this.configService.get<string>('JAZZCASH_INTEGRITY_SALT');
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
