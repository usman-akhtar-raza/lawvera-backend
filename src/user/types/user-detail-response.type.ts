import { LawyerProfile } from '../../lawyer/schemas/lawyer-profile.schema';
import { User } from '../schemas/user.schema';

export type UserDetailResponse = {
  user: User;
  lawyerProfile: LawyerProfile | null;
};
