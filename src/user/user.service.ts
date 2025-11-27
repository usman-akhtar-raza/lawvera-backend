import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  findAll() {
    return this.userModel.find().select('-password -refreshTokenHash');
  }

  async findById(id: string) {
    const user = await this.userModel
      .findById(id)
      .select('-password -refreshTokenHash');
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async update(id: string, dto: UpdateUserDto) {
    const updated = await this.userModel
      .findByIdAndUpdate(id, dto, { new: true })
      .select('-password -refreshTokenHash');
    if (!updated) {
      throw new NotFoundException('User not found');
    }
    return updated;
  }
}
