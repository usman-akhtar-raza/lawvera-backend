import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { BookingStatus } from '../../common/enums/booking-status.enum';
import { PaymentStatus } from '../../common/enums/payment-status.enum';

export type FinanceTransactionDocument = HydratedDocument<FinanceTransaction>;

@Schema({ _id: false })
export class FinanceParticipantSnapshot {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  email?: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ trim: true })
  city?: string;

  @Prop({ trim: true })
  specialization?: string;
}

export const FinanceParticipantSnapshotSchema = SchemaFactory.createForClass(
  FinanceParticipantSnapshot,
);

@Schema({ timestamps: true })
export class FinanceTransaction {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Booking',
    required: true,
    unique: true,
  })
  booking: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  client: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'LawyerProfile', required: true })
  lawyerProfile: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  lawyerUser: Types.ObjectId;

  @Prop({ type: FinanceParticipantSnapshotSchema, required: true })
  clientSnapshot: FinanceParticipantSnapshot;

  @Prop({ type: FinanceParticipantSnapshotSchema, required: true })
  lawyerSnapshot: FinanceParticipantSnapshot;

  @Prop({ required: true, min: 0 })
  amountMinor: number;

  @Prop({ required: true, default: 'PKR', trim: true })
  currency: string;

  @Prop({ required: true, default: 'jazzcash', trim: true })
  provider: string;

  @Prop({
    type: String,
    enum: Object.values(PaymentStatus),
    required: true,
  })
  paymentStatus: PaymentStatus;

  @Prop({
    type: String,
    enum: Object.values(BookingStatus),
    required: true,
  })
  bookingStatus: BookingStatus;

  @Prop({ required: true, unique: true, trim: true })
  txnRefNo: string;

  @Prop({ required: true, trim: true })
  receiptNumber: string;

  @Prop({ trim: true })
  txnDateTime?: string;

  @Prop({ trim: true })
  txnExpiryDateTime?: string;

  @Prop({ trim: true })
  billReference?: string;

  @Prop({ trim: true })
  description?: string;

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

  @Prop({ required: true })
  appointmentDate: Date;

  @Prop({ required: true, trim: true })
  slotTime: string;

  @Prop({ trim: true })
  reason?: string;

  @Prop({ trim: true })
  notes?: string;

  @Prop({ type: SchemaTypes.Mixed })
  lastCallbackPayload?: Record<string, unknown>;

  @Prop({ required: true })
  lastSyncedAt: Date;
}

export const FinanceTransactionSchema =
  SchemaFactory.createForClass(FinanceTransaction);

FinanceTransactionSchema.index({ client: 1, paidAt: -1, createdAt: -1 });
FinanceTransactionSchema.index({ lawyerUser: 1, paidAt: -1, createdAt: -1 });
FinanceTransactionSchema.index({ paymentStatus: 1, paidAt: -1, createdAt: -1 });
