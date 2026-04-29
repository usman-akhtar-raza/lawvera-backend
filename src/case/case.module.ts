import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CaseController } from './case.controller';
import { CaseService } from './case.service';
import { Case, CaseSchema } from './schemas/case.schema';
import { PaypalEscrowService } from './paypal-escrow.service';
import {
  LawyerProfile,
  LawyerProfileSchema,
} from '../lawyer/schemas/lawyer-profile.schema';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    CommonModule,
    MongooseModule.forFeature([
      { name: Case.name, schema: CaseSchema },
      { name: LawyerProfile.name, schema: LawyerProfileSchema },
    ]),
  ],
  controllers: [CaseController],
  providers: [CaseService, PaypalEscrowService],
  exports: [CaseService],
})
export class CaseModule {}
