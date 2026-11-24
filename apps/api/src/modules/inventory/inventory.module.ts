import { InventorySubresourcesController } from './inventory-subresources.controller.js';
import { InventorySubresourcesService } from './inventory-subresources.service.js';
import { SettingsAdminController } from './settings-admin.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { ImportsController } from './imports.controller.js';
import { ImportRecordsService } from './import-records.service.js';
import { OperationalFilesController } from './operational-files.controller.js';
import { LabelsController } from './labels.controller.js';
import { ReportsController } from './reports.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { AssetAuditsController } from './asset-audits.controller.js';
import { AssetAuditsService } from './asset-audits.service.js';
import { DepreciationController } from './depreciation.controller.js';
import { InventoryReadModelsController } from './inventory-read-models.controller.js';
import { InventoryReadModelsService } from './inventory-read-models.service.js';
import { MaintenanceController, MaintenanceTypesController } from './maintenance.controller.js';
import { MaintenanceService } from './maintenance.service.js';
import { ConsumableActionsController, LicenseSeatsController, SecondaryInventoryController } from './secondary-inventory.controller.js';
import { PredefinedKitsController } from './predefined-kits.controller.js';
import { PredefinedKitsService } from './predefined-kits.service.js';
import { SecondaryAssignmentsService } from './secondary-assignments.service.js';
import { SecondaryCatalogService } from './secondary-catalog.service.js';
import { AssetCheckoutService } from './asset-checkout.service.js';
import { CheckoutAcceptancesService } from './checkout-acceptances.service.js';
import { CheckoutRequestsService } from './checkout-requests.service.js';
import { InventoryMailModule } from './inventory-mail.module.js';
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
import { StorageDeletionService } from './storage-deletion.service.js';

@Module({
  imports: [StorageModule, AuthModule, InventoryMailModule],
  controllers: [
    SettingsAdminController,
    InventorySubresourcesController,
    OperationalFilesController,
    LabelsController,
    ReportsController,
    ImportsController,
    NotificationsController,
    SecondaryInventoryController,
    LicenseSeatsController,
    ConsumableActionsController,
    PredefinedKitsController,
    AssetAuditsController,
    DepreciationController,
    InventoryReadModelsController,
    MaintenanceController,
    MaintenanceTypesController,
    CustomFieldsController,
    CustomFieldsetsController,
    AssetModelsController,
    HardwareController,
    DepreciationSelectorController,
    SavedSearchesController,
    AssetWorkflowsController,
    InventoryAccountController,
    InventoryRequestsController,
    DirectoryController,
  ],
  providers: [
    InventorySubresourcesService,
    StorageDeletionService,
    ImportRecordsService,
    SecondaryCatalogService,
    SecondaryAssignmentsService,
    PredefinedKitsService,
    AssetAuditsService,
    InventoryReadModelsService,
    MaintenanceService,
    DirectoryService,
    FmcsScopeService,
    CustomFieldsService,
    CustomFieldsValidationService,
    AssetModelsService,
    HardwareService,
    AssetCheckoutService,
    CheckoutAcceptancesService,
    CheckoutRequestsService,
  ],
})
export class InventoryModule {}
