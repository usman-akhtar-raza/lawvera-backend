import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Case, CaseDocument } from './schemas/case.schema';
import {
  LawyerProfile,
  LawyerProfileDocument,
} from '../lawyer/schemas/lawyer-profile.schema';
import { CreateCaseDto } from './dto/create-case.dto';
import { UpdateCaseStatusDto } from './dto/update-case-status.dto';
import { AssignLawyerDto } from './dto/assign-lawyer.dto';
import { CreateCaseRequestDto } from './dto/create-case-request.dto';
import { SearchCaseFeedDto } from './dto/search-case-feed.dto';
import { CreateCaseEscrowDto } from './dto/create-case-escrow.dto';
import { CaptureCaseEscrowDto } from './dto/capture-case-escrow.dto';
import { CaseEscrowNoteDto } from './dto/case-escrow-note.dto';
import { CaseStatus } from '../common/enums/case-status.enum';
import { CaseRequestStatus } from '../common/enums/case-request-status.enum';
import { LawyerStatus } from '../common/enums/lawyer-status.enum';
import { UserRole } from '../common/enums/role.enum';
import { NotificationService } from '../common/services/notification.service';
import { isAdminRole } from '../common/utils/role.utils';
import { CaseEscrowStatus } from '../common/enums/case-escrow-status.enum';
import { CaseEscrowDisputeStatus } from '../common/enums/case-escrow-dispute-status.enum';
import { PaypalEscrowService } from './paypal-escrow.service';

@Injectable()
export class CaseService {
  constructor(
    @InjectModel(Case.name)
    private readonly caseModel: Model<CaseDocument>,
    @InjectModel(LawyerProfile.name)
    private readonly lawyerModel: Model<LawyerProfileDocument>,
    private readonly notificationService: NotificationService,
    private readonly paypalEscrowService: PaypalEscrowService,
    private readonly configService: ConfigService,
  ) {}

  async create(clientId: string, dto: CreateCaseDto) {
    const newCase = await this.caseModel.create({
      title: dto.title,
      description: dto.description,
      category: dto.category,
      status: CaseStatus.OPEN,
      client: clientId,
      lawyerRequests: [],
      activityLog: [
        {
          action: 'Case created',
          actor: clientId,
          createdAt: new Date(),
        },
      ],
    });

    return newCase.populate('client', 'name email role city');
  }

  async findById(caseId: string, actorId: string, role: UserRole) {
    const found = await this.caseModel
      .findById(caseId)
      .populate('client', 'name email role city')
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .populate({
        path: 'lawyerRequests.lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .populate('activityLog.actor', 'name role');

    if (!found) {
      throw new NotFoundException('Case not found');
    }

    if (role === UserRole.CLIENT && found.client._id.toString() !== actorId) {
      throw new ForbiddenException('You do not have access to this case');
    }

    if (role === UserRole.LAWYER) {
      const profile = await this.lawyerModel.findOne({ user: actorId });
      const assignedLawyerId =
        found.lawyer && '_id' in (found.lawyer as any)
          ? (found.lawyer as any)._id.toString()
          : found.lawyer?.toString();
      const isAssignedToLawyer =
        !!profile && assignedLawyerId === profile._id.toString();
      const isLiveUnassignedCase =
        !!profile &&
        profile.status !== LawyerStatus.REJECTED &&
        found.status === CaseStatus.OPEN &&
        !found.lawyer;

      if (!profile || (!isAssignedToLawyer && !isLiveUnassignedCase)) {
        throw new ForbiddenException('You do not have access to this case');
      }

      if (isLiveUnassignedCase) {
        this.keepOnlyLawyerRequest(found, profile._id.toString());
      }
    }

    return found;
  }

  async getClientCases(clientId: string) {
    return this.caseModel
      .find({ client: clientId })
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .populate({
        path: 'lawyerRequests.lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .sort({ createdAt: -1 });
  }

  async getLawyerCases(lawyerUserId: string) {
    const profile = await this.lawyerModel.findOne({ user: lawyerUserId });
    if (!profile) {
      throw new NotFoundException('Lawyer profile not found');
    }

    return this.caseModel
      .find({ lawyer: profile._id })
      .populate('client', 'name email role city')
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .populate({
        path: 'lawyerRequests.lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .sort({ createdAt: -1 });
  }

  async searchLawyerCaseFeed(lawyerUserId: string, query: SearchCaseFeedDto) {
    const profile = await this.lawyerModel.findOne({ user: lawyerUserId });
    if (!profile) {
      throw new NotFoundException('Lawyer profile not found');
    }

    if (profile.status === LawyerStatus.REJECTED) {
      throw new ForbiddenException(
        'This lawyer profile cannot search open cases',
      );
    }

    const filters: any[] = [
      { status: CaseStatus.OPEN },
      { $or: [{ lawyer: { $exists: false } }, { lawyer: null }] },
    ];

    if (query.category) {
      filters.push({ category: query.category });
    }

    const search = query.search?.trim();
    if (search) {
      const searchRegex = new RegExp(this.escapeRegExp(search), 'i');
      filters.push({
        $or: [
          { title: searchRegex },
          { description: searchRegex },
          { category: searchRegex },
        ],
      });
    }

    const cases = await this.caseModel
      .find({ $and: filters })
      .populate('client', 'name city')
      .populate({
        path: 'lawyerRequests.lawyer',
        populate: { path: 'user', select: 'name city' },
      })
      .sort({ createdAt: -1 })
      .limit(50);

    const lawyerProfileId = profile._id.toString();
    cases.forEach((legalCase) =>
      this.keepOnlyLawyerRequest(legalCase, lawyerProfileId),
    );

    return cases;
  }

  async adminGetAll() {
    return this.caseModel
      .find()
      .populate('client', 'name email role city')
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .populate({
        path: 'lawyerRequests.lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .sort({ createdAt: -1 });
  }

  async assignLawyer(
    caseId: string,
    dto: AssignLawyerDto,
    actorId: string,
    role: UserRole,
  ) {
    const found = await this.caseModel.findById(caseId);
    if (!found) {
      throw new NotFoundException('Case not found');
    }

    if (role === UserRole.CLIENT && found.client.toString() !== actorId) {
      throw new ForbiddenException();
    }

    if (
      found.status !== CaseStatus.OPEN &&
      found.status !== CaseStatus.ASSIGNED
    ) {
      throw new BadRequestException(
        'Lawyer can only be assigned to open or assigned cases',
      );
    }

    const lawyerProfile = await this.lawyerModel.findById(dto.lawyerId);
    if (!lawyerProfile || lawyerProfile.status !== LawyerStatus.APPROVED) {
      throw new BadRequestException('Lawyer is not available for assignment');
    }

    found.lawyer = lawyerProfile._id;
    found.status = CaseStatus.ASSIGNED;
    const now = new Date();
    found.lawyerRequests?.forEach((request) => {
      if (request.lawyer.toString() === lawyerProfile._id.toString()) {
        request.status = CaseRequestStatus.ACCEPTED;
        request.respondedAt = now;
      } else if (request.status === CaseRequestStatus.PENDING) {
        request.status = CaseRequestStatus.REJECTED;
        request.respondedAt = now;
      }
    });
    found.activityLog.push({
      action: `Lawyer assigned: ${lawyerProfile.specialization}`,
      actor: actorId as any,
      createdAt: new Date(),
    });
    await found.save();

    await this.notificationService.notifyLawyer(
      lawyerProfile.user.toString(),
      `You have been assigned a new case: "${found.title}"`,
    );

    return found.populate([
      { path: 'client', select: 'name email role city' },
      { path: 'lawyer', populate: { path: 'user', select: 'name email role city' } },
      {
        path: 'lawyerRequests.lawyer',
        populate: { path: 'user', select: 'name email role city' },
      },
    ]);
  }

  async createLawyerRequest(
    caseId: string,
    lawyerUserId: string,
    dto: CreateCaseRequestDto,
  ) {
    const found = await this.caseModel.findById(caseId);
    if (!found) {
      throw new NotFoundException('Case not found');
    }

    if (found.status !== CaseStatus.OPEN || found.lawyer) {
      throw new BadRequestException(
        'This case is not accepting lawyer requests',
      );
    }

    const lawyerProfile = await this.lawyerModel.findOne({
      user: lawyerUserId,
    });
    if (!lawyerProfile || lawyerProfile.status === LawyerStatus.REJECTED) {
      throw new BadRequestException(
        'This lawyer profile cannot request open cases',
      );
    }

    found.lawyerRequests = found.lawyerRequests || [];
    const alreadyRequested = found.lawyerRequests.some(
      (request) => request.lawyer.toString() === lawyerProfile._id.toString(),
    );
    if (alreadyRequested) {
      throw new BadRequestException('You have already requested this case');
    }

    found.lawyerRequests.push({
      lawyer: lawyerProfile._id,
      message: dto.message?.trim() || undefined,
      status: CaseRequestStatus.PENDING,
      createdAt: new Date(),
    });
    found.activityLog.push({
      action: `Lawyer requested case: ${lawyerProfile.specialization}`,
      actor: lawyerUserId as any,
      note: dto.message?.trim() || undefined,
      createdAt: new Date(),
    });

    await found.save();

    await this.notificationService.notifyClient(
      found.client.toString(),
      `A lawyer requested your case: "${found.title}"`,
    );

    return found.populate([
      { path: 'client', select: 'name email role city' },
      { path: 'lawyer', populate: { path: 'user', select: 'name email role city' } },
      {
        path: 'lawyerRequests.lawyer',
        populate: { path: 'user', select: 'name email role city' },
      },
      { path: 'activityLog.actor', select: 'name role' },
    ]);
  }

  async acceptLawyerRequest(
    caseId: string,
    lawyerId: string,
    actorId: string,
    role: UserRole,
  ) {
    const found = await this.caseModel.findById(caseId);
    if (!found) {
      throw new NotFoundException('Case not found');
    }

    if (role === UserRole.CLIENT && found.client.toString() !== actorId) {
      throw new ForbiddenException();
    }

    if (found.status !== CaseStatus.OPEN || found.lawyer) {
      throw new BadRequestException(
        'Lawyer requests can only be accepted on open cases',
      );
    }

    const request = found.lawyerRequests?.find(
      (item) =>
        item.lawyer.toString() === lawyerId &&
        item.status === CaseRequestStatus.PENDING,
    );
    if (!request) {
      throw new NotFoundException('Pending lawyer request not found');
    }

    const lawyerProfile = await this.lawyerModel.findById(lawyerId);
    if (!lawyerProfile || lawyerProfile.status === LawyerStatus.REJECTED) {
      throw new BadRequestException('Lawyer is not available for assignment');
    }

    const now = new Date();
    found.lawyer = lawyerProfile._id;
    found.status = CaseStatus.ASSIGNED;
    found.lawyerRequests.forEach((item) => {
      if (item.lawyer.toString() === lawyerId) {
        item.status = CaseRequestStatus.ACCEPTED;
      } else if (item.status === CaseRequestStatus.PENDING) {
        item.status = CaseRequestStatus.REJECTED;
      }
      item.respondedAt = now;
    });
    found.activityLog.push({
      action: `Lawyer selected: ${lawyerProfile.specialization}`,
      actor: actorId as any,
      createdAt: now,
    });

    await found.save();

    await this.notificationService.notifyLawyer(
      lawyerProfile.user.toString(),
      `Your request was accepted for case: "${found.title}"`,
    );

    return found.populate([
      { path: 'client', select: 'name email role city' },
      { path: 'lawyer', populate: { path: 'user', select: 'name email role city' } },
      {
        path: 'lawyerRequests.lawyer',
        populate: { path: 'user', select: 'name email role city' },
      },
      { path: 'activityLog.actor', select: 'name role' },
    ]);
  }

  async createEscrowOrder(
    caseId: string,
    dto: CreateCaseEscrowDto,
    actorId: string,
    role: UserRole,
  ) {
    const found = await this.getCaseForEscrowMutation(caseId, actorId, role);
    if (!found.lawyer) {
      throw new BadRequestException(
        'Assign a lawyer before creating an escrow payment.',
      );
    }

    if (
      found.status !== CaseStatus.ASSIGNED &&
      found.status !== CaseStatus.IN_PROGRESS &&
      found.status !== CaseStatus.RESOLVED
    ) {
      throw new BadRequestException(
        'Escrow can only be created for assigned, in-progress, or resolved cases.',
      );
    }

    const escrowStatus = found.escrow?.status || CaseEscrowStatus.NOT_STARTED;
    if (
      [
        CaseEscrowStatus.PENDING_APPROVAL,
        CaseEscrowStatus.HELD,
        CaseEscrowStatus.RELEASE_PENDING,
        CaseEscrowStatus.RELEASED,
        CaseEscrowStatus.REFUND_PENDING,
      ].includes(escrowStatus)
    ) {
      throw new BadRequestException(
        'An active escrow payment already exists for this case.',
      );
    }

    const lawyerProfile = await this.lawyerModel.findById(found.lawyer);
    if (!lawyerProfile) {
      throw new NotFoundException('Assigned lawyer profile not found');
    }

    const amountMinor = this.amountToMinor(dto.amount);
    const currency =
      dto.currency?.trim().toUpperCase() ||
      this.paypalEscrowService.getDefaultCurrency();
    const commissionRateBps = this.getCommissionRateBps();
    const platformCommissionMinor = Math.round(
      (amountMinor * commissionRateBps) / 10_000,
    );
    const lawyerAmountMinor = amountMinor - platformCommissionMinor;
    const invoiceId = this.buildInvoiceId(found._id.toString());
    const createdAt = new Date();
    const checkoutMode = dto.checkoutMode || 'wallet';

    const order = await this.paypalEscrowService.createCheckoutOrder({
      amountMinor,
      brandName: this.paypalEscrowService.getBrandName(),
      caseId: found._id.toString(),
      checkoutMode,
      cancelUrl:
        checkoutMode === 'wallet'
          ? this.buildEscrowCancelUrl(found._id.toString())
          : undefined,
      currency,
      description: `Legal case escrow for ${found.title}`.slice(0, 127),
      invoiceId,
      returnUrl:
        checkoutMode === 'wallet'
          ? this.buildEscrowReturnUrl(found._id.toString())
          : undefined,
    });

    found.escrow = {
      ...(found.escrow || { provider: 'paypal' }),
      provider: 'paypal',
      status: CaseEscrowStatus.PENDING_APPROVAL,
      disputeStatus: CaseEscrowDisputeStatus.NONE,
      amountMinor,
      currency,
      platformCommissionRateBps: commissionRateBps,
      platformCommissionMinor,
      lawyerAmountMinor,
      invoiceId,
      paypalOrderId: order.orderId,
      paypalCaptureId: undefined,
      paypalPayoutBatchId: undefined,
      paypalPayoutItemId: undefined,
      paypalPayoutStatus: undefined,
      paypalRefundId: undefined,
      payerId: undefined,
      payerEmail: undefined,
      initiatedAt: createdAt,
      approvedAt: undefined,
      capturedAt: undefined,
      releaseRequestedAt: undefined,
      releasedAt: undefined,
      refundedAt: undefined,
      cancelledAt: undefined,
      disputedAt: undefined,
      disputeResolvedAt: undefined,
      lastPayPalEvent: undefined,
      lastWebhookId: undefined,
      lastWebhookAt: undefined,
      lastIpnTxnId: undefined,
      lastError: undefined,
    } as any;
    found.activityLog.push({
      action: 'Escrow checkout created',
      actor: actorId as any,
      note: `Amount ${currency} ${(amountMinor / 100).toFixed(2)}`,
      createdAt,
    });
    found.markModified('escrow');
    await found.save();

    return {
      case: await this.populateCaseById(found._id.toString()),
      approvalUrl: order.approvalUrl,
      orderId: order.orderId,
    };
  }

  async getPayPalCardConfig() {
    const clientId = this.paypalEscrowService.getClientId();
    if (!clientId) {
      throw new InternalServerErrorException(
        'PayPal client ID is not configured for card checkout.',
      );
    }

    const clientToken = await this.paypalEscrowService.generateClientToken();

    return {
      clientId,
      clientToken,
      currency: this.paypalEscrowService.getDefaultCurrency(),
    };
  }

  async captureEscrowOrder(
    caseId: string,
    dto: CaptureCaseEscrowDto,
    actorId: string,
    role: UserRole,
  ) {
    const found = await this.getCaseForEscrowMutation(caseId, actorId, role);
    if (!found.escrow?.paypalOrderId) {
      throw new BadRequestException(
        'No PayPal escrow checkout was created for this case.',
      );
    }

    if (found.escrow.paypalOrderId !== dto.orderId) {
      throw new BadRequestException(
        'This PayPal order does not belong to the selected case.',
      );
    }

    if (
      [
        CaseEscrowStatus.HELD,
        CaseEscrowStatus.RELEASE_PENDING,
        CaseEscrowStatus.RELEASED,
        CaseEscrowStatus.REFUND_PENDING,
        CaseEscrowStatus.REFUNDED,
      ].includes(found.escrow.status)
    ) {
      return this.populateCaseById(found._id.toString());
    }

    const capture = await this.paypalEscrowService.captureOrder(
      dto.orderId,
      `lawvera-capture-${found._id.toString()}`,
    );
    const assignedLawyer = await this.lawyerModel.findById(found.lawyer).select('user');
    const now = new Date();
    found.escrow.status = CaseEscrowStatus.HELD;
    found.escrow.paypalCaptureId = capture.captureId;
    found.escrow.payerId = capture.payerId;
    found.escrow.payerEmail = capture.payerEmail?.toLowerCase();
    found.escrow.capturedAt = now;
    found.escrow.approvedAt = now;
    found.escrow.lastError = undefined;
    found.activityLog.push({
      action: 'Escrow funded and held',
      actor: actorId as any,
      note: `PayPal capture ${capture.captureId}`,
      createdAt: now,
    });
    found.markModified('escrow');
    await found.save();

    await this.notificationService.notifyLawyer(
      lawyerProfileUserId(assignedLawyer || found.lawyer),
      `Escrow funds are now held for case "${found.title}".`,
    );

    if (
      found.status === CaseStatus.RESOLVED &&
      found.escrow.disputeStatus !== CaseEscrowDisputeStatus.OPEN
    ) {
      await this.releaseEscrowFunds(
        found,
        actorId,
        'Automatic release after post-resolution funding',
        false,
        false,
      );
    }

    return this.populateCaseById(found._id.toString());
  }

  async cancelEscrowOrder(
    caseId: string,
    dto: CaseEscrowNoteDto,
    actorId: string,
    role: UserRole,
  ) {
    const found = await this.getCaseForEscrowMutation(caseId, actorId, role);
    if (found.escrow?.status !== CaseEscrowStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        'Only pending escrow checkouts can be cancelled.',
      );
    }

    found.escrow.status = CaseEscrowStatus.CANCELLED;
    found.escrow.cancelledAt = new Date();
    found.escrow.lastError = undefined;
    found.activityLog.push({
      action: 'Escrow checkout cancelled',
      actor: actorId as any,
      note: dto.note?.trim() || 'Cancelled before capture',
      createdAt: new Date(),
    });
    found.markModified('escrow');
    await found.save();

    return this.populateCaseById(found._id.toString());
  }

  async openEscrowDispute(
    caseId: string,
    dto: CaseEscrowNoteDto,
    actorId: string,
    role: UserRole,
  ) {
    const found = await this.getCaseForEscrowMutation(caseId, actorId, role);
    if (!found.escrow?.paypalCaptureId) {
      throw new BadRequestException(
        'You can only dispute an escrow that has already been funded.',
      );
    }

    found.escrow.disputeStatus = CaseEscrowDisputeStatus.OPEN;
    found.escrow.disputedAt = found.escrow.disputedAt || new Date();
    found.activityLog.push({
      action: 'Escrow dispute opened',
      actor: actorId as any,
      note: dto.note?.trim() || 'Client requested review',
      createdAt: new Date(),
    });
    found.markModified('escrow');
    await found.save();

    return this.populateCaseById(found._id.toString());
  }

  async releaseEscrowPayment(
    caseId: string,
    dto: CaseEscrowNoteDto,
    actorId: string,
    role: UserRole,
  ) {
    if (!isAdminRole(role)) {
      throw new ForbiddenException(
        'Only admins can manually release escrow funds.',
      );
    }

    const found = await this.getCaseForEscrowMutation(caseId, actorId, role);
    await this.releaseEscrowFunds(
      found,
      actorId,
      dto.note?.trim(),
      true,
      false,
    );

    return this.populateCaseById(found._id.toString());
  }

  async refundEscrowPayment(
    caseId: string,
    dto: CaseEscrowNoteDto,
    actorId: string,
    role: UserRole,
  ) {
    if (!isAdminRole(role)) {
      throw new ForbiddenException(
        'Only admins can manually refund escrow funds.',
      );
    }

    const found = await this.getCaseForEscrowMutation(caseId, actorId, role);
    if (found.escrow?.status !== CaseEscrowStatus.HELD) {
      throw new BadRequestException(
        'Escrow can only be refunded while funds are still being held.',
      );
    }

    if (!found.escrow.paypalCaptureId) {
      throw new BadRequestException(
        'This escrow does not have a captured PayPal payment to refund.',
      );
    }

    found.escrow.status = CaseEscrowStatus.REFUND_PENDING;
    found.markModified('escrow');
    await found.save();

    try {
      const refund = await this.paypalEscrowService.refundCapture(
        found.escrow.paypalCaptureId,
        `lawvera-refund-${found._id.toString()}`,
        dto.note?.trim(),
      );
      found.escrow.paypalRefundId = refund.refundId;
      found.escrow.status =
        refund.status === 'COMPLETED'
          ? CaseEscrowStatus.REFUNDED
          : CaseEscrowStatus.REFUND_PENDING;
      found.escrow.refundedAt =
        refund.status === 'COMPLETED' ? new Date() : undefined;
      found.escrow.disputeStatus = CaseEscrowDisputeStatus.RESOLVED;
      found.escrow.disputeResolvedAt = new Date();
      found.escrow.lastError = undefined;
      found.activityLog.push({
        action: 'Escrow refunded to client',
        actor: actorId as any,
        note: dto.note?.trim() || 'Refunded by admin',
        createdAt: new Date(),
      });
    } catch (error) {
      found.escrow.status = CaseEscrowStatus.HELD;
      found.escrow.lastError = this.getErrorMessage(error);
      found.markModified('escrow');
      await found.save();
      throw error;
    }

    found.markModified('escrow');
    await found.save();
    await this.notificationService.notifyClient(
      found.client.toString(),
      `Your escrow payment for "${found.title}" has been refunded.`,
    );
    return this.populateCaseById(found._id.toString());
  }

  async handlePayPalWebhook(
    headers: Record<string, string | string[] | undefined>,
    body: Record<string, unknown>,
  ) {
    const verified = await this.paypalEscrowService.verifyWebhookSignature(
      headers,
      body as Record<string, any>,
    );

    if (!verified) {
      throw new ForbiddenException('PayPal webhook signature verification failed');
    }

    const event = body as Record<string, any>;
    const eventType = this.extractString(event.event_type) || 'unknown';
    const webhookId = this.extractString(event.id);
    const resource =
      event.resource && typeof event.resource === 'object'
        ? (event.resource as Record<string, any>)
        : {};

    const found = await this.findCaseForPayPalEvent(eventType, resource);
    if (!found) {
      return { received: true, processed: false, eventType };
    }

    this.applyPayPalEventMetadata(found, eventType, webhookId);

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      found.escrow.status =
        found.escrow.status === CaseEscrowStatus.RELEASED
          ? found.escrow.status
          : CaseEscrowStatus.HELD;
      found.escrow.capturedAt = found.escrow.capturedAt || new Date();
      found.escrow.paypalCaptureId =
        found.escrow.paypalCaptureId || this.extractString(resource.id);
    } else if (
      eventType === 'PAYMENT.CAPTURE.DENIED' ||
      eventType === 'PAYMENT.CAPTURE.DECLINED'
    ) {
      found.escrow.status = CaseEscrowStatus.FAILED;
      found.escrow.lastError =
        this.extractString(resource.status_details?.reason) ||
        event.summary ||
        'PayPal capture failed.';
    } else if (eventType === 'PAYMENT.CAPTURE.PENDING') {
      found.escrow.lastError = 'PayPal capture is still pending.';
    } else if (
      eventType === 'PAYMENT.CAPTURE.REFUNDED' ||
      eventType === 'PAYMENT.CAPTURE.REVERSED'
    ) {
      found.escrow.status = CaseEscrowStatus.REFUNDED;
      found.escrow.refundedAt = new Date();
      found.escrow.disputeStatus = CaseEscrowDisputeStatus.RESOLVED;
      found.escrow.disputeResolvedAt = new Date();
    } else if (eventType === 'PAYMENT.REFUND.PENDING') {
      found.escrow.status = CaseEscrowStatus.REFUND_PENDING;
    } else if (eventType === 'PAYMENT.REFUND.FAILED') {
      found.escrow.status = CaseEscrowStatus.HELD;
      found.escrow.lastError = 'PayPal reported that the refund failed.';
    } else if (eventType === 'CHECKOUT.PAYMENT-APPROVAL.REVERSED') {
      found.escrow.status = CaseEscrowStatus.CANCELLED;
      found.escrow.cancelledAt = new Date();
    } else if (eventType === 'CUSTOMER.DISPUTE.CREATED') {
      found.escrow.disputeStatus = CaseEscrowDisputeStatus.OPEN;
      found.escrow.disputedAt = new Date();
    } else if (eventType === 'CUSTOMER.DISPUTE.UPDATED') {
      found.escrow.disputeStatus = CaseEscrowDisputeStatus.OPEN;
    } else if (eventType === 'CUSTOMER.DISPUTE.RESOLVED') {
      found.escrow.disputeStatus = CaseEscrowDisputeStatus.RESOLVED;
      found.escrow.disputeResolvedAt = new Date();
    } else if (eventType === 'PAYMENT.PAYOUTSBATCH.PROCESSING') {
      found.escrow.status = CaseEscrowStatus.RELEASE_PENDING;
      found.escrow.paypalPayoutStatus = 'PROCESSING';
    } else if (eventType === 'PAYMENT.PAYOUTSBATCH.SUCCESS') {
      found.escrow.status = CaseEscrowStatus.RELEASED;
      found.escrow.releasedAt = found.escrow.releasedAt || new Date();
      found.escrow.paypalPayoutStatus = 'SUCCESS';
    } else if (eventType === 'PAYMENT.PAYOUTSBATCH.DENIED') {
      found.escrow.status = CaseEscrowStatus.HELD;
      found.escrow.paypalPayoutStatus = 'DENIED';
      found.escrow.lastError = 'PayPal denied the payout batch.';
    } else if (eventType === 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED') {
      found.escrow.status = CaseEscrowStatus.RELEASED;
      found.escrow.releasedAt = found.escrow.releasedAt || new Date();
      found.escrow.paypalPayoutStatus = 'SUCCESS';
    } else if (eventType === 'PAYMENT.PAYOUTS-ITEM.HELD') {
      found.escrow.status = CaseEscrowStatus.RELEASE_PENDING;
      found.escrow.paypalPayoutStatus = 'HELD';
    } else if (eventType === 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED') {
      found.escrow.status = CaseEscrowStatus.RELEASE_PENDING;
      found.escrow.paypalPayoutStatus = 'UNCLAIMED';
      found.escrow.lastError = 'The lawyer has not claimed the PayPal payout.';
    } else if (
      [
        'PAYMENT.PAYOUTS-ITEM.FAILED',
        'PAYMENT.PAYOUTS-ITEM.CANCELED',
        'PAYMENT.PAYOUTS-ITEM.RETURNED',
        'PAYMENT.PAYOUTS-ITEM.REFUNDED',
        'PAYMENT.PAYOUTS-ITEM.BLOCKED',
      ].includes(eventType)
    ) {
      found.escrow.status = CaseEscrowStatus.HELD;
      found.escrow.paypalPayoutStatus = eventType.replace(
        'PAYMENT.PAYOUTS-ITEM.',
        '',
      );
      found.escrow.lastError = event.summary || 'PayPal payout did not complete.';
    }

    found.markModified('escrow');
    await found.save();

    return { received: true, processed: true, eventType };
  }

  async handlePayPalIpn(rawBody: string, body: Record<string, unknown>) {
    if (!rawBody) {
      throw new BadRequestException(
        'PayPal IPN validation requires access to the raw request body.',
      );
    }

    const verification = await this.paypalEscrowService.verifyIpn(rawBody);
    if (verification !== 'VERIFIED') {
      throw new ForbiddenException('PayPal IPN validation failed');
    }

    const invoiceId = this.extractString(body.invoice) || this.extractString(body.custom);
    const txnId =
      this.extractString(body.txn_id) || this.extractString(body.parent_txn_id);
    const found = await this.findCaseByEscrowIdentifiers({
      invoiceId,
      captureId: txnId,
      orderId: txnId,
    });

    if (!found) {
      return { received: true, processed: false };
    }

    found.escrow.lastIpnTxnId = txnId;
    found.escrow.lastWebhookAt = new Date();
    const paymentStatus = this.extractString(body.payment_status)?.toLowerCase();

    if (paymentStatus === 'completed' && found.escrow.status !== CaseEscrowStatus.RELEASED) {
      found.escrow.status = CaseEscrowStatus.HELD;
    } else if (paymentStatus === 'pending') {
      found.escrow.lastError = 'PayPal IPN indicates that the payment is pending.';
    } else if (paymentStatus === 'refunded' || paymentStatus === 'reversed') {
      found.escrow.status = CaseEscrowStatus.REFUNDED;
      found.escrow.refundedAt = new Date();
      found.escrow.disputeStatus = CaseEscrowDisputeStatus.RESOLVED;
      found.escrow.disputeResolvedAt = new Date();
    } else if (
      paymentStatus === 'denied' ||
      paymentStatus === 'failed' ||
      paymentStatus === 'voided'
    ) {
      found.escrow.status = CaseEscrowStatus.FAILED;
    }

    if (
      this.extractString(body.case_type)?.toLowerCase() === 'chargeback' ||
      this.extractString(body.dispute_reason)
    ) {
      found.escrow.disputeStatus = CaseEscrowDisputeStatus.OPEN;
      found.escrow.disputedAt = new Date();
    }

    found.markModified('escrow');
    await found.save();
    return { received: true, processed: true };
  }

  async updateStatus(
    caseId: string,
    dto: UpdateCaseStatusDto,
    actorId: string,
    role: UserRole,
  ) {
    const found = await this.caseModel.findById(caseId);
    if (!found) {
      throw new NotFoundException('Case not found');
    }

    // Validate access
    if (role === UserRole.CLIENT && found.client.toString() !== actorId) {
      throw new ForbiddenException();
    }

    if (role === UserRole.LAWYER) {
      const profile = await this.lawyerModel.findOne({ user: actorId });
      if (
        !profile ||
        !found.lawyer ||
        found.lawyer.toString() !== profile._id.toString()
      ) {
        throw new ForbiddenException();
      }
    }

    // Validate transitions
    this.validateStatusTransition(found.status, dto.status, role);

    found.status = dto.status;

    if (dto.status === CaseStatus.RESOLVED) {
      found.resolutionSummary = dto.note;
      found.resolvedAt = new Date();
    }

    if (dto.status === CaseStatus.CLOSED) {
      found.closedAt = new Date();
    }

    found.activityLog.push({
      action: `Status changed to ${dto.status}`,
      actor: actorId as any,
      note: dto.note,
      createdAt: new Date(),
    });

    await found.save();

    if (
      dto.status === CaseStatus.RESOLVED &&
      found.escrow?.status === CaseEscrowStatus.HELD &&
      found.escrow?.disputeStatus !== CaseEscrowDisputeStatus.OPEN
    ) {
      await this.releaseEscrowFunds(
        found,
        actorId,
        'Automatic release after case resolution',
        false,
        true,
      );
    }

    // Notify relevant parties
    if (role !== UserRole.CLIENT) {
      await this.notificationService.notifyClient(
        found.client.toString(),
        `Your case "${found.title}" status is now: ${dto.status}`,
      );
    }

    if (role !== UserRole.LAWYER && found.lawyer) {
      const lawyerProfile = await this.lawyerModel.findById(found.lawyer);
      if (lawyerProfile) {
        await this.notificationService.notifyLawyer(
          lawyerProfile.user.toString(),
          `Case "${found.title}" status updated to: ${dto.status}`,
        );
      }
    }

    return this.populateCaseById(found._id.toString());
  }

  async analytics() {
    const [total, open, assigned, inProgress, resolved, closed] =
      await Promise.all([
        this.caseModel.countDocuments(),
        this.caseModel.countDocuments({ status: CaseStatus.OPEN }),
        this.caseModel.countDocuments({ status: CaseStatus.ASSIGNED }),
        this.caseModel.countDocuments({ status: CaseStatus.IN_PROGRESS }),
        this.caseModel.countDocuments({ status: CaseStatus.RESOLVED }),
        this.caseModel.countDocuments({ status: CaseStatus.CLOSED }),
      ]);

    return { total, open, assigned, inProgress, resolved, closed };
  }

  private validateStatusTransition(
    current: CaseStatus,
    next: CaseStatus,
    role: UserRole,
  ) {
    const allowed: Record<CaseStatus, CaseStatus[]> = {
      [CaseStatus.OPEN]: [CaseStatus.ASSIGNED, CaseStatus.CLOSED],
      [CaseStatus.ASSIGNED]: [
        CaseStatus.IN_PROGRESS,
        CaseStatus.OPEN,
        CaseStatus.CLOSED,
      ],
      [CaseStatus.IN_PROGRESS]: [CaseStatus.RESOLVED, CaseStatus.CLOSED],
      [CaseStatus.RESOLVED]: [CaseStatus.CLOSED, CaseStatus.IN_PROGRESS],
      [CaseStatus.CLOSED]: [],
    };

    if (isAdminRole(role)) {
      // Admin can force any transition except from closed
      if (current === CaseStatus.CLOSED && next !== CaseStatus.CLOSED) {
        throw new BadRequestException('Closed cases cannot be reopened');
      }
      return;
    }

    if (!allowed[current]?.includes(next)) {
      throw new BadRequestException(
        `Cannot transition from "${current}" to "${next}"`,
      );
    }

    // Only lawyers can mark in_progress or resolved
    if (
      (next === CaseStatus.IN_PROGRESS || next === CaseStatus.RESOLVED) &&
      role === UserRole.CLIENT
    ) {
      throw new ForbiddenException(
        'Only the assigned lawyer can update case to this status',
      );
    }

    // Only client or admin can close
    if (next === CaseStatus.CLOSED && role === UserRole.LAWYER) {
      throw new ForbiddenException('Lawyers cannot close cases directly');
    }
  }

  private keepOnlyLawyerRequest(found: CaseDocument, lawyerProfileId: string) {
    found.lawyerRequests = (found.lawyerRequests || []).filter(
      (request) => this.getLawyerId(request.lawyer) === lawyerProfileId,
    );
  }

  private getLawyerId(lawyer: unknown) {
    if (lawyer && typeof lawyer === 'object' && '_id' in lawyer) {
      return String((lawyer as { _id: unknown })._id);
    }

    return lawyer ? String(lawyer) : undefined;
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async releaseEscrowFunds(
    found: CaseDocument,
    actorId: string,
    note?: string,
    overrideDispute = false,
    suppressErrors = false,
  ) {
    if (!found.lawyer) {
      if (suppressErrors) {
        return false;
      }
      throw new BadRequestException('Cannot release escrow without an assigned lawyer.');
    }

    if (found.escrow?.status === CaseEscrowStatus.RELEASED) {
      return true;
    }

    if (found.escrow?.status !== CaseEscrowStatus.HELD) {
      if (suppressErrors) {
        return false;
      }
      throw new BadRequestException('Escrow funds are not currently held for release.');
    }

    if (
      found.escrow.disputeStatus === CaseEscrowDisputeStatus.OPEN &&
      !overrideDispute
    ) {
      if (suppressErrors) {
        return false;
      }
      throw new BadRequestException(
        'Escrow is currently disputed and cannot be released automatically.',
      );
    }

    const lawyerProfile = await this.lawyerModel.findById(found.lawyer);
    if (!lawyerProfile?.paypalEmail) {
      const message =
        'The assigned lawyer has not configured a PayPal payout email.';
      found.escrow.lastError = message;
      found.markModified('escrow');
      await found.save();
      if (suppressErrors) {
        return false;
      }
      throw new BadRequestException(message);
    }

    found.escrow.status = CaseEscrowStatus.RELEASE_PENDING;
    found.escrow.releaseRequestedAt = new Date();
    found.markModified('escrow');
    await found.save();

    try {
      const payout = await this.paypalEscrowService.createPayout({
        amountMinor: found.escrow.lawyerAmountMinor || 0,
        currency: found.escrow.currency || this.paypalEscrowService.getDefaultCurrency(),
        note:
          (note || `Lawvera payout for case "${found.title}"`).slice(0, 255),
        recipientEmail: lawyerProfile.paypalEmail,
        senderBatchId: `lawvera-payout-${found._id.toString()}-${Date.now()}`,
        senderItemId: `lawvera-case-${found._id.toString()}`,
        subject: 'Lawvera case payout',
      });

      found.escrow.paypalPayoutBatchId = payout.batchId;
      found.escrow.paypalPayoutItemId = payout.itemId;
      found.escrow.paypalPayoutStatus = payout.status;
      found.escrow.status =
        payout.status === 'SUCCESS'
          ? CaseEscrowStatus.RELEASED
          : CaseEscrowStatus.RELEASE_PENDING;
      found.escrow.releasedAt =
        payout.status === 'SUCCESS' ? new Date() : undefined;
      if (overrideDispute && found.escrow.disputeStatus === CaseEscrowDisputeStatus.OPEN) {
        found.escrow.disputeStatus = CaseEscrowDisputeStatus.RESOLVED;
        found.escrow.disputeResolvedAt = new Date();
      }
      found.escrow.lastError = undefined;
      found.activityLog.push({
        action: 'Escrow payout initiated',
        actor: actorId as any,
        note: note || 'Released to assigned lawyer',
        createdAt: new Date(),
      });
      found.markModified('escrow');
      await found.save();
      await this.notificationService.notifyLawyer(
        lawyerProfile.user.toString(),
        `Your payout for case "${found.title}" has been initiated.`,
      );
      return true;
    } catch (error) {
      found.escrow.status = CaseEscrowStatus.HELD;
      found.escrow.lastError = this.getErrorMessage(error);
      found.markModified('escrow');
      await found.save();
      if (suppressErrors) {
        return false;
      }
      throw error;
    }
  }

  private async getCaseForEscrowMutation(
    caseId: string,
    actorId: string,
    role: UserRole,
  ) {
    const found = await this.caseModel.findById(caseId);
    if (!found) {
      throw new NotFoundException('Case not found');
    }

    if (role === UserRole.CLIENT && found.client.toString() !== actorId) {
      throw new ForbiddenException('You do not have access to this case');
    }

    if (role === UserRole.LAWYER) {
      throw new ForbiddenException(
        'Lawyers cannot change escrow payment details directly.',
      );
    }

    this.ensureEscrow(found);
    return found;
  }

  private async populateCaseById(caseId: string) {
    const found = await this.caseModel
      .findById(caseId)
      .populate('client', 'name email role city')
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .populate({
        path: 'lawyerRequests.lawyer',
        populate: { path: 'user', select: 'name email role city' },
      })
      .populate('activityLog.actor', 'name role');

    if (!found) {
      throw new NotFoundException('Case not found');
    }

    return found;
  }

  private amountToMinor(amount: number) {
    return Math.round(amount * 100);
  }

  private getCommissionRateBps() {
    return 1500;
  }

  private buildInvoiceId(caseId: string) {
    return `LAWVERA-CASE-${caseId}-${Date.now()}`.slice(0, 127);
  }

  private buildEscrowReturnUrl(caseId: string) {
    const baseUrl = this.getFrontendAppUrl();
    return `${baseUrl}/payments/paypal/return?caseId=${encodeURIComponent(caseId)}`;
  }

  private buildEscrowCancelUrl(caseId: string) {
    const baseUrl = this.getFrontendAppUrl();
    return `${baseUrl}/payments/paypal/return?caseId=${encodeURIComponent(caseId)}&cancelled=1`;
  }

  private getFrontendAppUrl() {
    const frontendUrl = this.configFrontendUrl();
    if (!frontendUrl) {
      throw new InternalServerErrorException(
        'FRONTEND_APP_URL is not configured for PayPal return handling.',
      );
    }

    return frontendUrl;
  }

  private configFrontendUrl() {
    return (
      this.configService
        .get<string>('FRONTEND_APP_URL')
        ?.trim()
        .replace(/\/+$/, '') || undefined
    );
  }

  private getErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unexpected PayPal operation failure.';
  }

  private applyPayPalEventMetadata(
    found: CaseDocument,
    eventType: string,
    webhookId?: string,
  ) {
    this.ensureEscrow(found);
    found.escrow.lastPayPalEvent = eventType;
    found.escrow.lastWebhookId = webhookId;
    found.escrow.lastWebhookAt = new Date();
  }

  private async findCaseForPayPalEvent(
    eventType: string,
    resource: Record<string, any>,
  ) {
    if (eventType.startsWith('PAYMENT.PAYOUT')) {
      return this.findCaseByEscrowIdentifiers({
        payoutBatchId:
          this.extractString(resource.payout_batch_id) ||
          this.extractString(resource?.batch_header?.payout_batch_id),
        payoutItemId:
          this.extractString(resource.payout_item_id) ||
          this.extractString(resource?.payout_item?.payout_item_id),
      });
    }

    if (eventType.startsWith('CUSTOMER.DISPUTE')) {
      const disputedTransaction =
        Array.isArray(resource.disputed_transactions) &&
        resource.disputed_transactions.length > 0
          ? resource.disputed_transactions[0]
          : undefined;
      const transactionInfo =
        disputedTransaction &&
        typeof disputedTransaction === 'object' &&
        'transaction_info' in disputedTransaction
          ? (disputedTransaction as Record<string, any>).transaction_info
          : disputedTransaction;

      return this.findCaseByEscrowIdentifiers({
        captureId:
          this.extractString(transactionInfo?.seller_transaction_id) ||
          this.extractString(transactionInfo?.buyer_transaction_id),
      });
    }

    return this.findCaseByEscrowIdentifiers({
      captureId:
        this.extractString(resource.id) ||
        this.extractString(resource?.supplementary_data?.related_ids?.capture_id),
      orderId:
        this.extractString(resource?.supplementary_data?.related_ids?.order_id) ||
        (eventType.startsWith('CHECKOUT.') ? this.extractString(resource.id) : undefined),
      invoiceId: this.extractString(resource.invoice_id),
    });
  }

  private async findCaseByEscrowIdentifiers(identifiers: {
    captureId?: string;
    invoiceId?: string;
    orderId?: string;
    payoutBatchId?: string;
    payoutItemId?: string;
  }) {
    const filters: Record<string, string>[] = [];
    if (identifiers.captureId) {
      filters.push({ 'escrow.paypalCaptureId': identifiers.captureId });
    }
    if (identifiers.orderId) {
      filters.push({ 'escrow.paypalOrderId': identifiers.orderId });
    }
    if (identifiers.invoiceId) {
      filters.push({ 'escrow.invoiceId': identifiers.invoiceId });
    }
    if (identifiers.payoutBatchId) {
      filters.push({ 'escrow.paypalPayoutBatchId': identifiers.payoutBatchId });
    }
    if (identifiers.payoutItemId) {
      filters.push({ 'escrow.paypalPayoutItemId': identifiers.payoutItemId });
    }

    if (filters.length === 0) {
      return null;
    }

    const found = await this.caseModel.findOne({ $or: filters });
    if (found) {
      this.ensureEscrow(found);
    }

    return found;
  }

  private extractString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private ensureEscrow(found: CaseDocument) {
    if (found.escrow) {
      return found.escrow;
    }

    found.escrow = {
      provider: 'paypal',
      status: CaseEscrowStatus.NOT_STARTED,
      disputeStatus: CaseEscrowDisputeStatus.NONE,
    } as any;

    return found.escrow;
  }
}

function lawyerProfileUserId(lawyer: unknown) {
  if (lawyer && typeof lawyer === 'object' && 'user' in lawyer) {
    const user = (lawyer as { user?: unknown }).user;
    if (typeof user === 'string') {
      return user;
    }
    if (user && typeof user === 'object' && '_id' in user) {
      return String((user as { _id: unknown })._id);
    }
  }

  return String(lawyer || '');
}
