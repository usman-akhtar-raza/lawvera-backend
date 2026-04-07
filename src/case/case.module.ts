import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CaseController } from './case.controller';
import { CaseService } from './case.service';
import { Case, CaseSchema } from './schemas/case.schema';
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
  providers: [CaseService],
  exports: [CaseService],
})
export class CaseModule {}
