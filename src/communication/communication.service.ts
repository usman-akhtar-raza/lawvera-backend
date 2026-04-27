import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Case, CaseDocument } from '../case/schemas/case.schema';
import {
  LawyerProfile,
  LawyerProfileDocument,
} from '../lawyer/schemas/lawyer-profile.schema';
import { User, UserDocument } from '../user/schemas/user.schema';
import { UserRole } from '../common/enums/role.enum';
import { SendMessageDto } from './dto/send-message.dto';
import {
  CommunicationMessage,
  CommunicationMessageDocument,
} from './schemas/communication-message.schema';
import {
  CommunicationThread,
  CommunicationThreadDocument,
} from './schemas/communication-thread.schema';

type SafeUser = {
  _id: string;
  name: string;
  email: string;
  role: UserRole;
  avatarUrl?: string;
};

type CaseAccessContext = {
  caseObjectId: Types.ObjectId;
  clientObjectId: Types.ObjectId;
  lawyerObjectId: Types.ObjectId;
  clientUserId: string;
  lawyerUserId: string;
};

@Injectable()
export class CommunicationService {
  constructor(
    @InjectModel(CommunicationThread.name)
    private readonly threadModel: Model<CommunicationThreadDocument>,
    @InjectModel(CommunicationMessage.name)
    private readonly messageModel: Model<CommunicationMessageDocument>,
    @InjectModel(Case.name)
    private readonly caseModel: Model<CaseDocument>,
    @InjectModel(LawyerProfile.name)
    private readonly lawyerModel: Model<LawyerProfileDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async listThreads(actorId: string, role: UserRole) {
    if (role !== UserRole.CLIENT && role !== UserRole.LAWYER) {
      throw new ForbiddenException('You do not have access to case chats');
    }

    const actorObjectId = this.toObjectId(actorId);
    const query = { participants: actorObjectId };

    const threads = await this.threadModel
      .find(query)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .populate('case', 'title status')
      .lean();

    const participantIds = Array.from(
      new Set(
        threads.flatMap((thread) =>
          (thread.participants ?? []).map((participant) =>
            this.objectIdToString(participant),
          ),
        ),
      ),
    );

    const participants = participantIds.length
      ? await this.userModel
          .find({ _id: { $in: participantIds.map((id) => this.toObjectId(id)) } })
          .select('name email role avatarUrl')
          .lean()
      : [];

    const participantMap = new Map<string, SafeUser>();
    for (const participant of participants) {
      participantMap.set(this.objectIdToString(participant._id), this.toSafeUser(participant));
    }

    return Promise.all(
      threads.map(async (thread) => {
        const unreadCount = await this.messageModel.countDocuments({
          thread: thread._id,
          sender: { $ne: actorObjectId },
          readBy: { $ne: actorObjectId },
        });

        const populatedCase =
          typeof thread.case === 'object' &&
          thread.case !== null &&
          '_id' in thread.case
            ? (thread.case as {
                _id: Types.ObjectId;
                title?: string;
                status?: string;
              })
            : null;

        return {
          threadId: this.objectIdToString(thread._id),
          caseId: populatedCase
            ? this.objectIdToString(populatedCase._id)
            : this.objectIdToString(thread.case as Types.ObjectId),
          caseTitle: populatedCase?.title ?? 'Untitled case',
          caseStatus: populatedCase?.status ?? 'open',
          participants: (thread.participants ?? [])
            .map((participant) =>
              participantMap.get(this.objectIdToString(participant)),
            )
            .filter((value): value is SafeUser => Boolean(value)),
          lastMessagePreview: thread.lastMessagePreview ?? '',
          lastMessageAt: this.toIsoDate(
            thread.lastMessageAt ?? new Date(),
          ),
          unreadCount,
        };
      }),
    );
  }

  async getCaseMessages(caseId: string, actorId: string, role: UserRole) {
    const actorObjectId = this.toObjectId(actorId);
    const access = await this.ensureCaseAccess(caseId, actorId, role);
    const thread = await this.threadModel.findOne({ case: access.caseObjectId }).lean();

    const participants = await this.loadParticipants([
      access.clientObjectId,
      access.lawyerObjectId,
    ]);

    if (!thread) {
      return {
        threadId: null,
        caseId,
        participants,
        unreadCount: 0,
        messages: [],
      };
    }

    const messages = await this.messageModel
      .find({ thread: thread._id })
      .sort({ createdAt: 1 })
      .populate('sender', 'name email role avatarUrl')
      .lean();

    const unreadCount = await this.messageModel.countDocuments({
      thread: thread._id,
      sender: { $ne: actorObjectId },
      readBy: { $ne: actorObjectId },
    });

    return {
      threadId: this.objectIdToString(thread._id),
      caseId,
      participants,
      unreadCount,
      messages: messages.map((message) => this.mapMessage(message)),
    };
  }

  async sendCaseMessage(
    caseId: string,
    actorId: string,
    role: UserRole,
    dto: SendMessageDto,
  ) {
    const content = dto.content.trim();
    if (!content.length) {
      throw new BadRequestException('Message content is required');
    }

    const access = await this.ensureCaseAccess(caseId, actorId, role);
    const senderObjectId = this.toObjectId(actorId);
    const thread = await this.getOrCreateThread(access);

    const created = await this.messageModel.create({
      thread: thread._id,
      case: access.caseObjectId,
      sender: senderObjectId,
      content,
      readBy: [senderObjectId],
    });

    await this.threadModel.findByIdAndUpdate(thread._id, {
      participants: [access.clientObjectId, access.lawyerObjectId],
      lastMessagePreview: this.toPreview(content),
      lastMessageAt: new Date(),
    });

    const populated = await this.messageModel
      .findById(created._id)
      .populate('sender', 'name email role avatarUrl')
      .lean();

    if (!populated) {
      throw new NotFoundException('Message could not be loaded');
    }

    return this.mapMessage(populated);
  }

  async markCaseMessagesRead(caseId: string, actorId: string, role: UserRole) {
    const actorObjectId = this.toObjectId(actorId);
    const access = await this.ensureCaseAccess(caseId, actorId, role);
    const thread = await this.threadModel.findOne({ case: access.caseObjectId }).lean();

    if (!thread) {
      return {
        marked: 0,
        unreadCount: 0,
      };
    }

    const result = await this.messageModel.updateMany(
      {
        thread: thread._id,
        sender: { $ne: actorObjectId },
        readBy: { $ne: actorObjectId },
      },
      {
        $addToSet: { readBy: actorObjectId },
      },
    );

    const unreadCount = await this.messageModel.countDocuments({
      thread: thread._id,
      sender: { $ne: actorObjectId },
      readBy: { $ne: actorObjectId },
    });

    return {
      marked: result.modifiedCount ?? 0,
      unreadCount,
    };
  }

  private async ensureCaseAccess(
    caseId: string,
    actorId: string,
    role: UserRole,
  ): Promise<CaseAccessContext> {
    if (role !== UserRole.CLIENT && role !== UserRole.LAWYER) {
      throw new ForbiddenException('You do not have access to this case chat');
    }

    const caseObjectId = this.toObjectId(caseId);
    const legalCase = await this.caseModel.findById(caseObjectId).lean();

    if (!legalCase) {
      throw new NotFoundException('Case not found');
    }

    const clientUserId = this.objectIdToString(legalCase.client);
    let lawyerUserId = '';

    if (legalCase.lawyer) {
      const lawyerProfile = await this.lawyerModel
        .findById(legalCase.lawyer)
        .select('user')
        .lean();
      if (lawyerProfile?.user) {
        lawyerUserId = this.objectIdToString(lawyerProfile.user);
      }
    }

    if (!lawyerUserId) {
      throw new BadRequestException(
        'Communication chat is available once a lawyer is assigned to this case',
      );
    }

    if (role === UserRole.CLIENT && clientUserId !== actorId) {
      throw new ForbiddenException('You do not have access to this case chat');
    }

    if (role === UserRole.LAWYER && lawyerUserId !== actorId) {
      throw new ForbiddenException('You do not have access to this case chat');
    }

    return {
      caseObjectId,
      clientObjectId: this.toObjectId(clientUserId),
      lawyerObjectId: this.toObjectId(lawyerUserId),
      clientUserId,
      lawyerUserId,
    };
  }

  private async getOrCreateThread(access: CaseAccessContext) {
    let thread = await this.threadModel.findOne({ case: access.caseObjectId });

    if (!thread) {
      thread = await this.threadModel.create({
        case: access.caseObjectId,
        participants: [access.clientObjectId, access.lawyerObjectId],
        lastMessagePreview: '',
        lastMessageAt: new Date(),
      });
      return thread;
    }

    const expectedParticipants = [
      access.clientObjectId.toString(),
      access.lawyerObjectId.toString(),
    ].sort();
    const currentParticipants = (thread.participants ?? [])
      .map((participant) => participant.toString())
      .sort();

    if (
      expectedParticipants.length !== currentParticipants.length ||
      expectedParticipants.some((value, index) => value !== currentParticipants[index])
    ) {
      thread.participants = [access.clientObjectId, access.lawyerObjectId];
      await thread.save();
    }

    return thread;
  }

  private async loadParticipants(participantIds: Types.ObjectId[]) {
    const ids = Array.from(new Set(participantIds.map((id) => id.toString())));
    if (!ids.length) {
      return [];
    }

    const participants = await this.userModel
      .find({ _id: { $in: ids.map((id) => this.toObjectId(id)) } })
      .select('name email role avatarUrl')
      .lean();

    return participants.map((participant) => this.toSafeUser(participant));
  }

  private mapMessage(message: {
    _id: Types.ObjectId;
    thread: Types.ObjectId;
    case: Types.ObjectId;
    sender:
      | Types.ObjectId
      | {
          _id: Types.ObjectId;
          name: string;
          email: string;
          role: UserRole;
          avatarUrl?: string;
        };
    content: string;
    readBy?: Types.ObjectId[];
    createdAt?: Date;
  }) {
    const populatedSender =
      typeof message.sender === 'object' &&
      message.sender !== null &&
      '_id' in message.sender &&
      'name' in message.sender
        ? this.toSafeUser(message.sender as any)
        : this.objectIdToString(message.sender as Types.ObjectId);

    return {
      _id: this.objectIdToString(message._id),
      threadId: this.objectIdToString(message.thread),
      caseId: this.objectIdToString(message.case),
      sender: populatedSender,
      content: message.content,
      readBy: (message.readBy ?? []).map((userId) => this.objectIdToString(userId)),
      createdAt: this.toIsoDate(message.createdAt ?? new Date()),
    };
  }

  private toSafeUser(user: {
    _id: Types.ObjectId;
    name: string;
    email: string;
    role: UserRole;
    avatarUrl?: string;
  }): SafeUser {
    return {
      _id: this.objectIdToString(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      avatarUrl: user.avatarUrl,
    };
  }

  private toPreview(content: string) {
    const normalized = content.trim().replace(/\s+/g, ' ');
    return normalized.length > 140
      ? `${normalized.slice(0, 137)}...`
      : normalized;
  }

  private toObjectId(value: string | Types.ObjectId): Types.ObjectId {
    if (value instanceof Types.ObjectId) {
      return value;
    }
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException('Invalid identifier');
    }
    return new Types.ObjectId(value);
  }

  private objectIdToString(value: string | Types.ObjectId | undefined | null) {
    if (!value) {
      return '';
    }
    return value instanceof Types.ObjectId ? value.toString() : value;
  }

  private toIsoDate(value: Date) {
    return value.toISOString();
  }
}
