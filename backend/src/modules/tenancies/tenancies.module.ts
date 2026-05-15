import { Module } from '@nestjs/common';
import { RentancyModule } from '../../integrations/rentancy/rentancy.module';
import { RentancyTenancyRefreshJob } from './jobs/rentancy-tenancy-refresh.job';
import { TenancyRefreshService } from './tenancy-refresh.service';

@Module({
  imports: [RentancyModule],
  providers: [TenancyRefreshService, RentancyTenancyRefreshJob],
  exports: [TenancyRefreshService, RentancyTenancyRefreshJob],
})
export class TenanciesModule {}
