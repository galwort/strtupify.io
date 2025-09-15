import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { environment } from 'src/environments/environment';

export const app = initializeApp(environment.firebase);
export const db = getFirestore(app);

@Component({
  selector: 'app-funding',
  templateUrl: './funding.page.html',
  styleUrls: ['./funding.page.scss'],
  standalone: false,
})
export class FundingPage implements OnInit {
  companyId = '';
  companyName = '';
  logo = '';
  loading = true;
  approved = false;
  amount = 0;
  graceDays = 0;
  firstPayment = 0;

  constructor(private route: ActivatedRoute, private router: Router) {}

  async ngOnInit() {
    this.companyId = this.route.snapshot.paramMap.get('id') || '';
    if (!this.companyId) {
      this.loading = false;
      return;
    }
    const ref = doc(db, 'companies', this.companyId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data: any = snap.data();
      this.companyName = data.company_name || '';
      this.logo = data.logo || '';
      const f = data.funding || {};
      this.approved = !!f.approved;
      this.amount = Number(f.amount || 0);
      this.graceDays = Number(f.grace_period_days || 0);
      this.firstPayment = Number(f.first_payment || 0);
    }
    this.loading = false;
  }

  continue() {
    if (this.companyId) this.router.navigateByUrl(`/company/${this.companyId}`);
  }
}

