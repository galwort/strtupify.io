import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { CompanyProfilePage } from './company-profile.page';

const routes: Routes = [
  {
    path: '',
    component: CompanyProfilePage,
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class CompanyProfilePageRoutingModule {}

