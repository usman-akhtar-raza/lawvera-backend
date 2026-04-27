import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LawyerController } from './lawyer.controller';
import { LawyerService } from './lawyer.service';
import {
  LawyerProfile,
  LawyerProfileSchema,
} from './schemas/lawyer-profile.schema';
import {
  Specialization,
  SpecializationSchema,
} from './schemas/specialization.schema';
import { User, UserSchema } from '../user/schemas/user.schema';
import { CommonModule } from '../common/common.module';
import { Booking, BookingSchema } from '../booking/schemas/booking.schema';
import { Case, CaseSchema } from '../case/schemas/case.schema';

@Module({
  imports: [
    CommonModule,
    MongooseModule.forFeature([
      { name: LawyerProfile.name, schema: LawyerProfileSchema },
      { name: Specialization.name, schema: SpecializationSchema },
      { name: User.name, schema: UserSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Case.name, schema: CaseSchema },
    ]),
  ],
  controllers: [LawyerController],
  providers: [LawyerService],
  exports: [LawyerService],
})
export class LawyerModule {}
