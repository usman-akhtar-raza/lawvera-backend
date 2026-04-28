import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { UserRole } from '../common/enums/role.enum';
import { User, UserSchema } from '../user/schemas/user.schema';

async function seedSuperAdmin() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is required');
  }

  const email = (
    process.env.SUPER_ADMIN_EMAIL || 'akhtarusman716+superadmin@gmail.com'
  ).toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD || 'Aa123456';
  const name = process.env.SUPER_ADMIN_NAME || 'Lawvera Super Admin';

  await mongoose.connect(mongoUri);
  const UserModel = mongoose.model(User.name, UserSchema);

  const hashedPassword = await bcrypt.hash(password, 10);
  const existing = await UserModel.findOne({ email });

  if (existing) {
    existing.role = UserRole.SUPER_ADMIN;
    existing.password = hashedPassword;
    existing.isEmailVerified = true;
    await existing.save();
    console.log(`Updated existing super admin user: ${email}`);
  } else {
    await UserModel.create({
      name,
      email,
      password: hashedPassword,
      role: UserRole.SUPER_ADMIN,
      isEmailVerified: true,
    });
    console.log(`Created super admin user: ${email}`);
  }

  await mongoose.disconnect();
}

seedSuperAdmin()
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    console.error(error);
    await mongoose.disconnect();
    process.exit(1);
  });
