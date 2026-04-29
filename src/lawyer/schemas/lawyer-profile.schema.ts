import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { LawyerStatus } from '../../common/enums/lawyer-status.enum';

export type LawyerProfileDocument = HydratedDocument<LawyerProfile>;

@Schema({ _id: false })
class AvailabilitySlot {
  @Prop({ required: true })
  day: string; // e.g. Monday

  @Prop({ type: [String], default: [] })
  slots: string[];
}

@Schema({ _id: false })
class Review {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  client: Types.ObjectId;

  @Prop({ min: 1, max: 5 })
  rating: number;

  @Prop()
  comment?: string;

  @Prop({ default: Date.now })
  createdAt: Date;
}

@Schema({ timestamps: true })
export class LawyerProfile {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  })
  user: Types.ObjectId;

  @Prop({ required: true })
  specialization: string;

  @Prop({ required: true })
  experienceYears: number;

  @Prop({ required: true })
  city: string;

  @Prop({ required: true })
  consultationFee: number;

  @Prop({ trim: true, lowercase: true })
  paypalEmail?: string;

  @Prop({ type: [AvailabilitySlot], default: [] })
  availability: AvailabilitySlot[];

  @Prop()
  education?: string;

  @Prop()
  description?: string;

  @Prop({
    type: String,
    enum: Object.values(LawyerStatus),
    default: LawyerStatus.PENDING,
  })
  status: LawyerStatus;

  @Prop({ default: 0 })
  ratingAverage: number;

  @Prop({ default: 0 })
  ratingCount: number;

  @Prop({ type: [Review], default: [] })
  reviews: Review[];

  @Prop()
  profilePhotoUrl?: string;
}

export const LawyerProfileSchema = SchemaFactory.createForClass(LawyerProfile);

LawyerProfileSchema.index({ status: 1, specialization: 1, city: 1 });
LawyerProfileSchema.index({ ratingAverage: -1 });
