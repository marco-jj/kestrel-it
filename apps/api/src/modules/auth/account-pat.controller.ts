import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreatePatRequestSchema,
  type AuthenticatedUserContext,
  type CreatePatResponse,
  type PatSummary,
  type StandardApiResponse,
} from '@kestrel-it/shared';
import { CurrentUser, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PatService } from './pat.service.js';

@ApiTags('Account')
@ApiBearerAuth()
@Controller('account/personal-access-tokens')
@RequirePermission('self.api')
export class AccountPatController {
  constructor(@Inject(PatService) private readonly patService: PatService) {}

  @Get()
  @ApiOperation({ summary: 'List active personal access tokens for the current user' })
  async list(@CurrentUser() user: AuthenticatedUserContext): Promise<PatSummary[]> {
    return this.patService.listUserTokens(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new personal access token (plaintext returned once)' })
  async create(
    @CurrentUser() user: AuthenticatedUserContext,
    @Body() body: unknown,
  ): Promise<StandardApiResponse<CreatePatResponse>> {
    const parsed = CreatePatRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        status: 'error',
        messages: parsed.error.flatten().fieldErrors,
        payload: null,
      });
    }

    const created = await this.patService.createToken(user, parsed.data);
    return {
      status: 'success',
      messages: 'Personal access token created.',
      payload: created,
    };
  }

  @Delete(':tokenId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an active personal access token' })
  async revoke(
    @CurrentUser() user: AuthenticatedUserContext,
    @Param('tokenId') tokenId: string,
  ): Promise<void> {
    await this.patService.revokeToken(user, tokenId);
  }
}
