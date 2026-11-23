import { StorageModule } from '../../common/storage/storage.module.js';
import { Module } from '@nestjs/common';
import { InventoryMailService } from './inventory-mail.service.js';

@Module({
  imports: [StorageModule],
  providers: [InventoryMailService],
  exports: [InventoryMailService],
})
export class InventoryMailModule {}
