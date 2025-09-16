import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, updateDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { MATERIAL_ICONS } from './icons';

const app = initializeApp(environment.firebase);
const db = getFirestore(app);

@Component({
  selector: 'app-company-profile',
  templateUrl: './company-profile.component.html',
  styleUrls: ['./company-profile.component.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule],
})
export class CompanyProfileComponent implements OnInit {
  @Input() companyId = '';
  name = '';
  description = '';
  logo = '';
  picking = false;
  query = '';
  filtered: string[] = [];
  private allIcons: string[] = [];
  selectedIcon = '';
  funding: { approved: boolean; amount: number; grace_period_days: number; first_payment: number } | null = null;
  foundedAt: string = '';
  hires: { id: string; name: string; title: string }[] = [];

  constructor(private http: HttpClient) {}

  async ngOnInit() {
    if (!this.companyId) return;
    const snap = await getDoc(doc(db, 'companies', this.companyId));
    const data = snap.data() as any;
    this.name = data?.company_name || '';
    this.description = data?.description || '';
    this.logo = data?.logo || '';
    this.selectedIcon = this.logo;
    const f = data?.funding || null;
    if (f) {
      this.funding = {
        approved: !!f.approved,
        amount: Number(f.amount || 0),
        grace_period_days: Number(f.grace_period_days || 0),
        first_payment: Number(f.first_payment || 0),
      };
    } else {
      this.funding = null;
    }
    this.foundedAt = data?.founded_at || '';

    const hiredSnap = await getDocs(
      query(collection(db, `companies/${this.companyId}/employees`), where('hired', '==', true))
    );
    this.hires = hiredSnap.docs.map((d) => {
      const x = d.data() as any;
      return { id: d.id, name: x.name || '', title: x.title || '' };
    });

    await this.loadIcons();
    this.onSearchChange('');
  }

  openPicker() {
    this.picking = true;
    this.onSearchChange(this.query);
  }

  cancelPicker() {
    this.picking = false;
    this.selectedIcon = this.logo;
  }

  onSearchChange(q: string) {
    this.query = q || '';
    const ql = this.query.toLowerCase();
    const base = this.allIcons.length ? this.allIcons : MATERIAL_ICONS;
    const list = ql ? base.filter((n) => n.toLowerCase().includes(ql)) : base;
    this.filtered = list.slice(0, 200);
  }

  choose(icon: string) {
    this.selectedIcon = icon;
  }

  async saveIcon() {
    if (!this.companyId || !this.selectedIcon) return;
    await updateDoc(doc(db, 'companies', this.companyId), { logo: this.selectedIcon });
    this.logo = this.selectedIcon;
    this.picking = false;
    try {
      window.dispatchEvent(new CustomEvent('company-logo-changed', { detail: this.logo }));
    } catch {}
  }

  private async loadIcons() {
    // Try cache first
    try {
      const cached = localStorage.getItem('materialIconsList');
      if (cached) {
        const arr = JSON.parse(cached) as string[];
        if (Array.isArray(arr) && arr.length) {
          this.allIcons = arr;
          return;
        }
      }
    } catch {}

    // Try network fetch via backend proxy (avoids browser CORS)
    try {
      const res = await firstValueFrom(
        this.http.get<{ icons: string[] }>('https://fa-strtupifyio.azurewebsites.net/api/material_icons')
      );
      const names = (res && Array.isArray(res.icons)) ? res.icons : [];
      if (names.length) {
        this.allIcons = names;
        try {
          localStorage.setItem('materialIconsList', JSON.stringify(names));
        } catch {}
        return;
      }
    } catch {}

    // Fallback to bundled list
    this.allIcons = MATERIAL_ICONS;
  }
}
