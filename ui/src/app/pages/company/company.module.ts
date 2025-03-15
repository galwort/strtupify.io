import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { CompanyPageRoutingModule } from './company-routing.module';

import { CompanyPage } from './company.page';

import { RolesComponent } from 'src/app/components/roles/roles.component';
import { LoadingComponent } from 'src/app/components/loading/loading.component';
import { ResumesComponent } from 'src/app/components/resumes/resumes.component';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    CompanyPageRoutingModule,
    RolesComponent,
    LoadingComponent,
    ResumesComponent,
  ],
  declarations: [CompanyPage],
})
export class CompanyPageModule {}
