import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CommunicationController } from './communication.controller';
import { CommunicationService } from './communication.service';
import {
  CommunicationThread,
  CommunicationThreadSchema,
} from './schemas/communication-thread.schema';
import {
  CommunicationMessage,
  CommunicationMessageSchema,
} from './schemas/communication-message.schema';
import { Case, CaseSchema } from '../case/schemas/case.schema';
import {
  LawyerProfile,
  LawyerProfileSchema,
} from '../lawyer/schemas/lawyer-profile.schema';
import { User, UserSchema } from '../user/schemas/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CommunicationThread.name, schema: CommunicationThreadSchema },
      { name: CommunicationMessage.name, schema: CommunicationMessageSchema },
      { name: Case.name, schema: CaseSchema },
      { name: LawyerProfile.name, schema: LawyerProfileSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [CommunicationController],
  providers: [CommunicationService],
})
export class CommunicationModule {}

