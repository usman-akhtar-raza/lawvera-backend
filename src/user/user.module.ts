import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { User, UserSchema } from './schemas/user.schema';
import {
  LawyerProfile,
  LawyerProfileSchema,
} from '../lawyer/schemas/lawyer-profile.schema';
import { LawyerModule } from '../lawyer/lawyer.module';
import { Booking, BookingSchema } from '../booking/schemas/booking.schema';
import { Case, CaseSchema } from '../case/schemas/case.schema';
import {
  ChatMessage,
  ChatMessageSchema,
} from '../chat/schemas/chat-message.schema';
import {
  CommunicationMessage,
  CommunicationMessageSchema,
} from '../communication/schemas/communication-message.schema';
import {
  CommunicationThread,
  CommunicationThreadSchema,
} from '../communication/schemas/communication-thread.schema';

@Module({
  imports: [
    LawyerModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: LawyerProfile.name, schema: LawyerProfileSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Case.name, schema: CaseSchema },
      { name: ChatMessage.name, schema: ChatMessageSchema },
      { name: CommunicationMessage.name, schema: CommunicationMessageSchema },
      { name: CommunicationThread.name, schema: CommunicationThreadSchema },
    ]),
  ],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
