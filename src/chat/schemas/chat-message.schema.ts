import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { ChatRole } from '../../common/enums/chat-role.enum';

export type ChatMessageDocument = HydratedDocument<ChatMessage>;

@Schema({ timestamps: true })
export class ChatMessage {
  @Prop({ required: true })
  sessionId: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(ChatRole), required: true })
  role: ChatRole;

  @Prop({ required: true })
  content: string;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);

