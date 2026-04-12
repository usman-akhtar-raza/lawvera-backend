import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Case } from '../../case/schemas/case.schema';
import { User } from '../../user/schemas/user.schema';
import { CommunicationThread } from './communication-thread.schema';

export type CommunicationMessageDocument =
  HydratedDocument<CommunicationMessage>;

@Schema({ timestamps: true })
export class CommunicationMessage {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: CommunicationThread.name,
    required: true,
  })
  thread: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: Case.name, required: true })
  case: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: User.name, required: true })
  sender: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  content: string;

  @Prop({
    type: [SchemaTypes.ObjectId],
    ref: User.name,
    default: [],
  })
  readBy: Types.ObjectId[];
}

export const CommunicationMessageSchema =
  SchemaFactory.createForClass(CommunicationMessage);

CommunicationMessageSchema.index({ thread: 1, createdAt: 1 });
CommunicationMessageSchema.index({ case: 1, createdAt: 1 });
CommunicationMessageSchema.index({ sender: 1, createdAt: -1 });

