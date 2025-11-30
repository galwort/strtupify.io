import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { CompanyPageRoutingModule } from './company-routing.module';

import { CompanyPage } from './company.page';

import { RolesComponent } from 'src/app/components/roles/roles.component';
import { LoadingComponent } from 'src/app/components/loading/loading.component';
import { ResumesComponent } from 'src/app/components/resumes/resumes.component';
import { BoardroomComponent } from 'src/app/components/boardroom/boardroom.component';
import { InboxComponent } from 'src/app/components/inbox/inbox.component';
import { CompanyProfileComponent } from 'src/app/components/company-profile/company-profile.component';
import { WorkItemsComponent } from 'src/app/components/work-items/work-items.component';
import { GeneralLedgerComponent } from 'src/app/components/general-ledger/general-ledger.component';
import { HumanResourcesComponent } from 'src/app/components/human-resources/human-resources.component';
import { HttpClientModule } from '@angular/common/http';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    HttpClientModule,
    CompanyPageRoutingModule,
    RolesComponent,
    LoadingComponent,
    ResumesComponent,
    BoardroomComponent,
    InboxComponent,
    CompanyProfileComponent,
    WorkItemsComponent,
    GeneralLedgerComponent,
    HumanResourcesComponent,
  ],
  declarations: [CompanyPage],
})
export class CompanyPageModule {}
