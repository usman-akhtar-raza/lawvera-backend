import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { BookingStatus } from '../../common/enums/booking-status.enum';

export type BookingDocument = HydratedDocument<Booking>;

@Schema({ timestamps: true })
export class Booking {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  client: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'LawyerProfile', required: true })
  lawyer: Types.ObjectId;

  @Prop({ required: true })
  slotDate: Date;

  @Prop({ required: true })
  slotTime: string; // e.g. '10:00 AM'

  @Prop({
    type: String,
    enum: Object.values(BookingStatus),
    required: true,
  })
  status: BookingStatus;

  @Prop()
  reason?: string;

  @Prop()
  notes?: string;
}

export const BookingSchema = SchemaFactory.createForClass(Booking);

BookingSchema.index({ client: 1, createdAt: -1 });
BookingSchema.index({ lawyer: 1, slotDate: 1, slotTime: 1 });
BookingSchema.index({ status: 1, slotDate: 1 });
