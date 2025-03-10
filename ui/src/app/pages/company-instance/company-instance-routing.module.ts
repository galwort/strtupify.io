import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';

import { CompanyInstancePage } from './company-instance.page';

const routes: Routes = [
  {
    path: '',
    component: CompanyInstancePage
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class CompanyInstancePageRoutingModule {}
