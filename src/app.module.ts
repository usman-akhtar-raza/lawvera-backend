import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { LawyerModule } from './lawyer/lawyer.module';
import { BookingModule } from './booking/booking.module';
import { ChatModule } from './chat/chat.module';
import { PrismaModule } from './database/prisma.module';
import { LawSourcesModule } from './law-sources/law-sources.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGO_URI'),
      }),
    }),
    PrismaModule,
    AuthModule,
    UserModule,
    LawyerModule,
    BookingModule,
    ChatModule,
    LawSourcesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
