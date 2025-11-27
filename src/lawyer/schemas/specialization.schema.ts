import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SpecializationDocument = HydratedDocument<Specialization>;

@Schema({ timestamps: true })
export class Specialization {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop()
  description?: string;
}

export const SpecializationSchema = SchemaFactory.createForClass(Specialization);

