import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { BookingStatus } from '../../common/enums/booking-status.enum';
import { PaymentStatus } from '../../common/enums/payment-status.enum';

export type BookingDocument = HydratedDocument<Booking>;

@Schema({ _id: false })
export class BookingPayment {
  @Prop({ default: 'jazzcash' })
  provider: string;

  @Prop({
    type: String,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.PENDING,
  })
  status: PaymentStatus;

  @Prop({ required: true, min: 0 })
  amountMinor: number;

  @Prop({ required: true, default: 'PKR' })
  currency: string;

  @Prop({ required: true, trim: true })
  txnRefNo: string;

  @Prop({ required: true, trim: true })
  txnDateTime: string;

  @Prop({ required: true, trim: true })
  txnExpiryDateTime: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ trim: true })
  billReference?: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ trim: true })
  redirectTokenHash?: string;

  @Prop()
  redirectTokenExpiresAt?: Date;

  @Prop({ default: false })
  secureHashVerified: boolean;

  @Prop({ trim: true })
  responseCode?: string;

  @Prop({ trim: true })
  responseMessage?: string;

  @Prop({ trim: true })
  retrievalReferenceNo?: string;

  @Prop({ trim: true })
  authCode?: string;

  @Prop()
  initiatedAt?: Date;

  @Prop()
  paidAt?: Date;

  @Prop()
  failedAt?: Date;
}

export const BookingPaymentSchema =
  SchemaFactory.createForClass(BookingPayment);

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

  @Prop({ required: true, min: 0 })
  consultationFee: number;

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

  @Prop({ trim: true })
  meetingLink?: string;

  @Prop({ type: BookingPaymentSchema, required: true })
  payment: BookingPayment;
}

export const BookingSchema = SchemaFactory.createForClass(Booking);

BookingSchema.index({ client: 1, createdAt: -1 });
BookingSchema.index({ lawyer: 1, slotDate: 1, slotTime: 1 });
BookingSchema.index({ status: 1, slotDate: 1 });
BookingSchema.index({ 'payment.txnRefNo': 1 }, { unique: true, sparse: true });
BookingSchema.index({ 'payment.status': 1, 'payment.expiresAt': 1 });
