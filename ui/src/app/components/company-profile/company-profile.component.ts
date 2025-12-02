import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, updateDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { MATERIAL_ICONS, RESERVED_ICONS } from './icons';

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
  aiSearching = false;
  aiError = '';
  private searchTimeout: any = null;
  private searchToken = 0;
  private lastSearchText = '';
  private recommended: string[] = [];
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
    this.filtered = this.filterIcons();
    this.queueSemanticSearch();
  }

  openPicker() {
    this.picking = true;
    this.filtered = this.filterIcons();
    this.queueSemanticSearch();
  }

  cancelPicker() {
    this.picking = false;
    this.selectedIcon = this.logo;
  }

  onSearchChange(q: string) {
    this.query = q || '';
    if (!this.query.trim()) {
      this.recommended = [];
      this.filtered = [];
      this.lastSearchText = '';
      this.aiError = '';
    }
    this.queueSemanticSearch();
  }

  choose(icon: string) {
    this.selectedIcon = icon;
  }

  async saveIcon() {
    if (!this.companyId || !this.selectedIcon) return;
    if (RESERVED_ICONS.includes(this.selectedIcon)) return;
    await updateDoc(doc(db, 'companies', this.companyId), { logo: this.selectedIcon });
    this.logo = this.selectedIcon;
    this.picking = false;
    try {
      window.dispatchEvent(new CustomEvent('company-logo-changed', { detail: this.logo }));
    } catch {}
  }

  private queueSemanticSearch() {
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => this.semanticSearch(), 350);
  }

  private async semanticSearch() {
    if (this.aiSearching) return;
    const text = (this.query || '').trim();
    if (!text) {
      this.recommended = [];
      this.filtered = [];
      this.lastSearchText = '';
      this.aiError = '';
      return;
    }
    if (text === this.lastSearchText) return;
    const token = ++this.searchToken;

    this.aiError = '';
    this.aiSearching = true;
    try {
      const logoUrl = 'https://fa-strtupifyio.azurewebsites.net/api/logo';
      const res = await firstValueFrom(
        this.http.post<{ best?: string; matches?: { icon: string; score: number }[] }>(
          logoUrl,
          { input: text, min_score: 0.55, limit: 24 }
        )
      );
      if (token !== this.searchToken) return;
      const matches = Array.isArray(res?.matches)
        ? res.matches.filter((m) => m && typeof m.icon === 'string')
        : [];
      const iconName = matches[0]?.icon || res?.best || '';
      if (iconName && !RESERVED_ICONS.includes(iconName)) {
        const iconsFromMatches = matches
          .map((m) => m.icon)
          .filter((i) => i && !RESERVED_ICONS.includes(i));

        // Merge all returned icons into the known list to keep them visible.
        const known = new Set(this.allIcons);
        for (const icon of iconsFromMatches) {
          if (!known.has(icon)) {
            this.allIcons.unshift(icon);
            known.add(icon);
          }
        }
        if (!known.has(iconName)) {
          this.allIcons.unshift(iconName);
        }

        this.selectedIcon = iconName;
        this.recommended = iconsFromMatches;
        this.lastSearchText = text;
        this.filtered = this.filterIcons();
      } else {
        this.recommended = [];
        this.aiError = 'Could not fetch a logo suggestion. Please try again.';
      }
    } catch (e) {
      if (token === this.searchToken) {
        this.aiError = 'Could not fetch a logo suggestion. Please try again.';
      }
    } finally {
      if (token === this.searchToken) {
        this.aiSearching = false;
      }
    }
  }

  private async loadIcons() {

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
        this.filtered = this.filterIcons();
        return;
      }
    } catch {}


    this.allIcons = MATERIAL_ICONS;
    this.filtered = this.filterIcons();
  }

  private filterIcons(): string[] {
    if (!this.query.trim()) return [];

    const rec = this.recommended.filter((n) => n && !RESERVED_ICONS.includes(n));
    let list = rec.length ? Array.from(new Set(rec)) : [];

    if (
      this.selectedIcon &&
      !RESERVED_ICONS.includes(this.selectedIcon) &&
      !list.includes(this.selectedIcon)
    ) {
      list = [this.selectedIcon, ...list];
    }

    return list.slice(0, 200);
  }
}
