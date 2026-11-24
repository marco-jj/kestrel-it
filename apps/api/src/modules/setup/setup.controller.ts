import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CompleteSetupRequestSchema,
  type LoginResponse,
  type PreflightStatusResponse,
  type StandardApiResponse,
} from '@kestrel-it/shared';
import { Public } from '../../common/decorators/auth.decorators.js';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../../common/guards/jwt-or-pat-auth.guard.js';
import { SetupNotCompletedGuard } from './setup-not-completed.guard.js';
import { SetupService } from './setup.service.js';
import { ApiZodBody } from '../../openapi/request-body.js';

interface HttpCookieReply {
  setCookie(name: string, value: string, options: Record<string, unknown>): unknown;
}

@ApiTags('Setup')
@Controller('setup')
export class SetupController {
  constructor(@Inject(SetupService) private readonly setupService: SetupService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Pre-flight diagnostics and first-run setup completion check' })
  async getStatus(): Promise<PreflightStatusResponse> {
    return this.setupService.getPreflightStatus();
  }

  @ApiZodBody(CompleteSetupRequestSchema)
  @Public()
  @UseGuards(SetupNotCompletedGuard)
  @Post('complete')
  @ApiOperation({
    summary: 'Complete initial setup by creating first Superuser and singleton settings',
  })
  async completeSetup(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: HttpCookieReply,
  ): Promise<StandardApiResponse<LoginResponse>> {
    const parsed = CompleteSetupRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        status: 'error',
        messages: parsed.error.flatten().fieldErrors,
        payload: null,
      });
    }

    const session = await this.setupService.completeSetup(parsed.data);

    if (session.status === 'authenticated') {
      const isProd = process.env['NODE_ENV'] === 'production';
      reply.setCookie(ACCESS_TOKEN_COOKIE, session.accessToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        path: '/',
      });
      reply.setCookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        path: '/',
      });
    }

    return {
      status: 'success',
      messages: 'Setup completed successfully.',
      payload: session,
    };
  }
}
