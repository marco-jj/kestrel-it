import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
} from '@nestjs/common';
import { DatabaseBootstrapService } from '../../db/bootstrap.service.js';

/**
 * Permanently blocks setup write endpoints once the first superuser and settings row exist.
 */
@Injectable()
export class SetupNotCompletedGuard implements CanActivate {
  constructor(
    @Inject(DatabaseBootstrapService)
    private readonly bootstrapService: DatabaseBootstrapService,
  ) {}

  async canActivate(): Promise<boolean> {
    const completed = await this.bootstrapService.isSetupCompleted();
    if (completed) {
      throw new ForbiddenException('Application setup has already been completed.');
    }
    return true;
  }
}
