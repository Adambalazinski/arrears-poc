import { Module, type Provider } from '@nestjs/common';
import { CognitoModule } from '../cognito/cognito.module';
import { CognitoService } from '../cognito/cognito.service';
import { FixtureRentancyClient } from './fixture-rentancy.client';
import { HttpRentancyClient } from './http-rentancy.client';
import { RENTANCY_CLIENT } from './rentancy.client';

const rentancyClientProvider: Provider = {
  provide: RENTANCY_CLIENT,
  inject: [CognitoService],
  useFactory: (cognito: CognitoService) => {
    const mode = (process.env.INTEGRATION_MODE ?? 'fixtures').toLowerCase();
    if (mode === 'stage') return new HttpRentancyClient(cognito);
    if (mode === 'fixtures') return new FixtureRentancyClient();
    throw new Error(`Unknown INTEGRATION_MODE="${mode}" (expected stage or fixtures)`);
  },
};

@Module({
  imports: [CognitoModule],
  providers: [rentancyClientProvider],
  exports: [rentancyClientProvider],
})
export class RentancyModule {}
