import { AssetCheckoutService } from './asset-checkout.service.js';
import { CheckoutAcceptancesService } from './checkout-acceptances.service.js';
import { CheckoutRequestsService } from './checkout-requests.service.js';
import { InventoryMailService } from './inventory-mail.service.js';
import {
  AssetWorkflowsController,
  InventoryAccountController,
  InventoryRequestsController,
} from './inventory-workflows.controller.js';
import { StorageModule } from '../../common/storage/storage.module.js';
import {
  AssetModelsController,
  DepreciationSelectorController,
  HardwareController,
} from './hardware.controller.js';
import { AssetModelsService } from './asset-models.service.js';
import { HardwareService } from './hardware.service.js';
import { SavedSearchesController } from './saved-searches.controller.js';
import { Module } from '@nestjs/common';
import { CustomFieldsController, CustomFieldsetsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { CustomFieldsValidationService } from './custom-fields-validation.service.js';
import { DirectoryController } from './directory.controller.js';
import { DirectoryService } from './directory.service.js';
import { FmcsScopeService } from './fmcs-scope.service.js';

@Module({
  imports: [StorageModule],
  controllers: [
    DirectoryController,
    CustomFieldsController,
    CustomFieldsetsController,
    AssetModelsController,
    HardwareController,
    DepreciationSelectorController,
    SavedSearchesController,
    AssetWorkflowsController,
    InventoryAccountController,
    InventoryRequestsController,
  ],
  providers: [
    DirectoryService,
    FmcsScopeService,
    CustomFieldsService,
    CustomFieldsValidationService,
    AssetModelsService,
    HardwareService,
    AssetCheckoutService,
    CheckoutAcceptancesService,
    CheckoutRequestsService,
    InventoryMailService,
  ],
})
export class InventoryModule {}
