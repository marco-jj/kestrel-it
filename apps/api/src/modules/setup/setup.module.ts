import { InventoryMailModule } from '../inventory/inventory-mail.module.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SetupNotCompletedGuard } from './setup-not-completed.guard.js';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

@Module({
  imports: [AuthModule, InventoryMailModule],
  controllers: [SetupController],
  providers: [SetupService, SetupNotCompletedGuard],
})
export class SetupModule {}
