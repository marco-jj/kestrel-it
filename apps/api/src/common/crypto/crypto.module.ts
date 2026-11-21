import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service.js';
import { JwtService } from './jwt.util.js';

@Global()
@Module({
  providers: [CryptoService, JwtService],
  exports: [CryptoService, JwtService],
})
export class CryptoModule {}
