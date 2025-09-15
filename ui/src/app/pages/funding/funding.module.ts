import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { FundingPageRoutingModule } from './funding-routing.module';
import { FundingPage } from './funding.page';

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule, FundingPageRoutingModule],
  declarations: [FundingPage],
})
export class FundingPageModule {}

