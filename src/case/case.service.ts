import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { CaseStatus } from '../common/enums/case-status.enum';
import { LawyerStatus } from '../common/enums/lawyer-status.enum';
import { UserRole } from '../common/enums/role.enum';
import { NotificationService } from '../common/services/notification.service';

@Injectable()
export class CaseService {
  constructor(
    @InjectModel(Case.name)
    private readonly caseModel: Model<CaseDocument>,
    @InjectModel(LawyerProfile.name)
    private readonly lawyerModel: Model<LawyerProfileDocument>,
    private readonly notificationService: NotificationService,
  ) {}

  async create(clientId: string, dto: CreateCaseDto) {
    const newCase = await this.caseModel.create({
      title: dto.title,
      description: dto.description,
      category: dto.category,
      status: CaseStatus.OPEN,
      client: clientId,
      activityLog: [
        {
          action: 'Case created',
          actor: clientId,
          createdAt: new Date(),
        },
      ],
    });

    return newCase.populate('client', 'name email city');
  }

  async findById(caseId: string, actorId: string, role: UserRole) {
    const found = await this.caseModel
      .findById(caseId)
      .populate('client', 'name email city phone')
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name email city' },
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
      if (
        !profile ||
        !found.lawyer ||
        found.lawyer._id.toString() !== profile._id.toString()
      ) {
        throw new ForbiddenException('You do not have access to this case');
      }
    }

    return found;
  }

  async getClientCases(clientId: string) {
    return this.caseModel
      .find({ client: clientId })
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name city' },
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
      .populate('client', 'name email city phone')
      .sort({ createdAt: -1 });
  }

  async adminGetAll() {
    return this.caseModel
      .find()
      .populate('client', 'name email')
      .populate({
        path: 'lawyer',
        populate: { path: 'user', select: 'name email' },
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
      { path: 'client', select: 'name email city' },
      { path: 'lawyer', populate: { path: 'user', select: 'name email city' } },
    ]);
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

    return found.populate([
      { path: 'client', select: 'name email city' },
      { path: 'lawyer', populate: { path: 'user', select: 'name email city' } },
    ]);
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
      [CaseStatus.ASSIGNED]: [CaseStatus.IN_PROGRESS, CaseStatus.OPEN, CaseStatus.CLOSED],
      [CaseStatus.IN_PROGRESS]: [CaseStatus.RESOLVED, CaseStatus.CLOSED],
      [CaseStatus.RESOLVED]: [CaseStatus.CLOSED, CaseStatus.IN_PROGRESS],
      [CaseStatus.CLOSED]: [],
    };

    if (role === UserRole.ADMIN) {
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
}
