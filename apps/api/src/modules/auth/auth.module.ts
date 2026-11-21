import { Module } from '@nestjs/common';
import { AccountPatController } from './account-pat.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { BetterAuthService } from './better-auth.service.js';
import { OidcUserProvisioningService } from './oidc-provisioning.service.js';
import { PatService } from './pat.service.js';

@Module({
  controllers: [AuthController, AccountPatController],
  providers: [OidcUserProvisioningService, AuthService, BetterAuthService, PatService],
  exports: [OidcUserProvisioningService, AuthService, BetterAuthService, PatService],
})
export class AuthModule {}
