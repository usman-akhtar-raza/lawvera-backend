import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Case } from '../../case/schemas/case.schema';
import { User } from '../../user/schemas/user.schema';

export type CommunicationThreadDocument = HydratedDocument<CommunicationThread>;

@Schema({ timestamps: true })
export class CommunicationThread {
  @Prop({ type: SchemaTypes.ObjectId, ref: Case.name, required: true, unique: true })
  case: Types.ObjectId;

  @Prop({
    type: [SchemaTypes.ObjectId],
    ref: User.name,
    required: true,
    default: [],
  })
  participants: Types.ObjectId[];

  @Prop({ default: '' })
  lastMessagePreview: string;

  @Prop()
  lastMessageAt?: Date;
}

export const CommunicationThreadSchema =
  SchemaFactory.createForClass(CommunicationThread);

CommunicationThreadSchema.index({ participants: 1, lastMessageAt: -1 });
CommunicationThreadSchema.index({ case: 1 }, { unique: true });

