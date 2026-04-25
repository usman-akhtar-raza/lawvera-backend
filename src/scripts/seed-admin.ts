import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { UserRole } from '../common/enums/role.enum';
import { User, UserSchema } from '../user/schemas/user.schema';

async function seedAdmin() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is required');
  }

  const email = (process.env.ADMIN_EMAIL || 'akhtarusman176+admin@gmail.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'Aa123456';
  const name = process.env.ADMIN_NAME || 'Lawvera Admin';

  await mongoose.connect(mongoUri);
  const UserModel = mongoose.model(User.name, UserSchema);

  const hashedPassword = await bcrypt.hash(password, 10);
  const existing = await UserModel.findOne({ email });

  if (existing) {
    existing.role = UserRole.ADMIN;
    existing.password = hashedPassword;
    await existing.save();
    console.log(`Updated existing admin user: ${email}`);
  } else {
    await UserModel.create({
      name,
      email,
      password: hashedPassword,
      role: UserRole.ADMIN,
    });
    console.log(`Created admin user: ${email}`);
  }


  await mongoose.disconnect();
}

seedAdmin()
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    console.error(error);
    await mongoose.disconnect();
    process.exit(1);
  });
