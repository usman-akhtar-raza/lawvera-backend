import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { CaseStatus } from '../../common/enums/case-status.enum';
import { CaseCategory } from '../../common/enums/case-category.enum';

export type CaseDocument = HydratedDocument<Case>;

@Schema({ timestamps: true })
export class Case {
  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  description: string;

  @Prop({
    type: String,
    enum: Object.values(CaseCategory),
    required: true,
  })
  category: CaseCategory;

  @Prop({
    type: String,
    enum: Object.values(CaseStatus),
    default: CaseStatus.OPEN,
  })
  status: CaseStatus;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  client: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'LawyerProfile' })
  lawyer?: Types.ObjectId;

  @Prop()
  resolutionSummary?: string;

  @Prop()
  resolvedAt?: Date;

  @Prop()
  closedAt?: Date;

  @Prop({
    type: [
      {
        action: { type: String, required: true },
        actor: { type: SchemaTypes.ObjectId, ref: 'User', required: true },
        note: { type: String },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  activityLog: Array<{
    action: string;
    actor: Types.ObjectId;
    note?: string;
    createdAt: Date;
  }>;
}

export const CaseSchema = SchemaFactory.createForClass(Case);

CaseSchema.index({ client: 1, createdAt: -1 });
CaseSchema.index({ lawyer: 1, status: 1 });
CaseSchema.index({ status: 1, createdAt: -1 });
CaseSchema.index({ category: 1 });
