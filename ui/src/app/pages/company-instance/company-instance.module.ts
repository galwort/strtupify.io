import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { CompanyInstancePageRoutingModule } from './company-instance-routing.module';

import { CompanyInstancePage } from './company-instance.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    CompanyInstancePageRoutingModule
  ],
  declarations: [CompanyInstancePage]
})
export class CompanyInstancePageModule {}
