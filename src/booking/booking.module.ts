import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { Booking, BookingSchema } from './schemas/booking.schema';
import {
  LawyerProfile,
  LawyerProfileSchema,
} from '../lawyer/schemas/lawyer-profile.schema';
import { CommonModule } from '../common/common.module';
import { User, UserSchema } from '../user/schemas/user.schema';
import { Case, CaseSchema } from '../case/schemas/case.schema';

@Module({
  imports: [
    CommonModule,
    MongooseModule.forFeature([
      { name: Booking.name, schema: BookingSchema },
      { name: LawyerProfile.name, schema: LawyerProfileSchema },
      { name: User.name, schema: UserSchema },
      { name: Case.name, schema: CaseSchema },
    ]),
  ],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
