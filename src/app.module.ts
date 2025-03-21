import { AuthModule } from 'src/auth/auth.module';
import { UnusedImageCleanupService } from 'src/common/cleanup/unused-image-cleanup.service';
import { CommonModule } from 'src/common/common.module';
import { EmailModule } from 'src/email/email.module';
import { MenuModule } from 'src/menu/menu.module';
import { OrderModule } from 'src/order/order.module';
import { ShopModule } from 'src/shop/shop.module';
import { TableSessionModule } from 'src/table-session/table-session.module';
import { UserModule } from 'src/user/user.module';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { AppService } from './app.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    AuthModule,
    CommonModule,
    EmailModule,
    MenuModule,
    OrderModule,
    ShopModule,
    TableSessionModule,
    UserModule,
  ],
  controllers: [],
  providers: [AppService, PrismaService, UnusedImageCleanupService],
  exports: [PrismaService],
})
export class AppModule {}
