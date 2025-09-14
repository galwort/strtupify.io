import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { environment } from 'src/environments/environment';

const app = initializeApp(environment.firebase);
const db = getFirestore(app);

@Component({
  selector: 'app-company-profile',
  templateUrl: './company-profile.page.html',
  styleUrls: ['./company-profile.page.scss'],
  standalone: false,
})
export class CompanyProfilePage implements OnInit {
  companyId = '';
  name = '';
  description = '';
  logo = '';

  constructor(private route: ActivatedRoute, private router: Router) {}

  async ngOnInit() {
    const segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) return;

    const snap = await getDoc(doc(db, 'companies', this.companyId));
    const data = snap.data() as any;
    this.name = data?.company_name || '';
    this.description = data?.description || '';
    this.logo = data?.logo || '';
  }
}

