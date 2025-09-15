import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';
import { FundingPage } from './funding.page';

const routes: Routes = [
  {
    path: '',
    component: FundingPage,
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class FundingPageRoutingModule {}

