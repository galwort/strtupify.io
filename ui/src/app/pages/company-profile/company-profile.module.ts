import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';

import { CompanyProfilePage } from './company-profile.page';
import { CompanyProfilePageRoutingModule } from './company-profile-routing.module';

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule, CompanyProfilePageRoutingModule],
  declarations: [CompanyProfilePage],
})
export class CompanyProfilePageModule {}

