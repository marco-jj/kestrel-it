import { Module } from '@nestjs/common';
import { DirectoryController } from './directory.controller.js';
import { DirectoryService } from './directory.service.js';
import { FmcsScopeService } from './fmcs-scope.service.js';

@Module({
  controllers: [DirectoryController],
  providers: [DirectoryService, FmcsScopeService],
})
export class InventoryModule {}
