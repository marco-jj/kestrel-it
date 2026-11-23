import { Module } from '@nestjs/common';
import { CustomFieldsController, CustomFieldsetsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { CustomFieldsValidationService } from './custom-fields-validation.service.js';
import { DirectoryController } from './directory.controller.js';
import { DirectoryService } from './directory.service.js';
import { FmcsScopeService } from './fmcs-scope.service.js';

@Module({
  controllers: [DirectoryController, CustomFieldsController, CustomFieldsetsController],
  providers: [
    DirectoryService,
    FmcsScopeService,
    CustomFieldsService,
    CustomFieldsValidationService,
  ],
})
export class InventoryModule {}
