import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, doc, getDoc, updateDoc, collection, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { MATERIAL_ICONS, RESERVED_ICONS } from './icons';
import { ThemeColors, ThemeColorKey, ThemeService } from '../../services/theme.service';

const app = initializeApp(environment.firebase);
const db = getFirestore(app);
const auth = getAuth(app);

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
  themeColors: ThemeColors;
  private loadedTheme: ThemeColors;
  private originalLogo = '';
  hasChanges = false;
  saving = false;
  colorError = '';

  constructor(private http: HttpClient, private theme: ThemeService) {
    this.themeColors = this.theme.getDefaultTheme();
    this.loadedTheme = this.themeColors;
  }

  async ngOnInit() {
    if (!this.companyId) return;
    const snap = await getDoc(doc(db, 'companies', this.companyId));
    const data = snap.data() as any;
    this.name = data?.company_name || '';
    this.description = data?.description || '';
    this.logo = data?.logo || '';
    this.selectedIcon = this.logo;
    this.originalLogo = (data as any)?.original_logo || this.logo || '';
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
    const themeFromCompany = this.theme.extractFromCompany(data);
    this.themeColors = this.theme.normalizeTheme(themeFromCompany);
    this.loadedTheme = this.themeColors;

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
    this.colorError = '';
  }

  cancelPicker() {
    this.picking = false;
    this.selectedIcon = this.logo;
    this.themeColors = this.loadedTheme;
    this.hasChanges = false;
    this.colorError = '';
    this.theme.applyTheme(this.loadedTheme);
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
    this.hasChanges = true;
  }

  async saveAll() {
    if (!this.companyId || !this.selectedIcon || RESERVED_ICONS.includes(this.selectedIcon)) return;
    if (this.saving) return;
    this.saving = true;
    this.colorError = '';
    const nextTheme = this.theme.normalizeTheme(this.themeColors);
    const logoChanged = this.selectedIcon !== this.logo;
    const themeChanged = !this.themesEqual(nextTheme, this.loadedTheme);
    if (!logoChanged && !themeChanged) {
      this.hasChanges = false;
      this.picking = false;
      this.saving = false;
      return;
    }

    const payload: any = {
      logo: this.selectedIcon,
      theme: nextTheme,
      brandUpdatedAt: serverTimestamp(),
      brandUpdated: true,
    };
    const updatedBy = auth.currentUser?.uid || null;
    if (updatedBy) {
      payload.brandUpdatedBy = updatedBy;
    }
    if (this.originalLogo) {
      payload.original_logo = this.originalLogo;
    } else if (this.logo) {
      payload.original_logo = this.logo;
      this.originalLogo = this.logo;
    }
    try {
      await updateDoc(doc(db, 'companies', this.companyId), payload);
      this.logo = this.selectedIcon;
      this.loadedTheme = nextTheme;
      this.themeColors = nextTheme;
      this.hasChanges = false;
      this.picking = false;
      this.theme.applyTheme(nextTheme);
      try {
        window.dispatchEvent(new CustomEvent('company-logo-changed', { detail: this.logo }));
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent('company-theme-changed', { detail: nextTheme }));
      } catch {}
    } catch (e) {
      this.colorError = 'Could not save changes. Please try again.';
    } finally {
      this.saving = false;
    }
  }

  onColorInput(key: ThemeColorKey, value: string) {
    this.colorError = '';
    this.themeColors = this.theme.normalizeTheme({ ...this.themeColors, [key]: value });
    this.hasChanges = true;
    this.theme.applyTheme(this.themeColors);
  }

  async resetToDefaults() {
    if (!this.companyId || this.saving) return;
    this.saving = true;
    this.colorError = '';
    const defaultTheme = this.theme.getDefaultTheme();
    const currentTheme = this.theme.normalizeTheme(this.themeColors);
    const logoToRestore = this.originalLogo || this.logo || this.selectedIcon;
    const themeChanged = !this.themesEqual(defaultTheme, currentTheme);
    const logoChanged = this.selectedIcon !== logoToRestore || this.logo !== logoToRestore;
    if (!themeChanged && !logoChanged) {
      this.saving = false;
      this.picking = false;
      this.hasChanges = false;
      return;
    }
    const payload: any = {
      logo: logoToRestore,
      theme: defaultTheme,
      brandUpdatedAt: serverTimestamp(),
      brandUpdated: true,
    };
    const updatedBy = auth.currentUser?.uid || null;
    if (updatedBy) {
      payload.brandUpdatedBy = updatedBy;
    }
    if (this.originalLogo) {
      payload.original_logo = this.originalLogo;
    }
    try {
      await updateDoc(doc(db, 'companies', this.companyId), payload);
      this.logo = logoToRestore;
      this.selectedIcon = logoToRestore;
      this.themeColors = defaultTheme;
      this.loadedTheme = defaultTheme;
      this.hasChanges = false;
      this.picking = false;
      this.theme.applyTheme(defaultTheme);
      try {
        window.dispatchEvent(new CustomEvent('company-logo-changed', { detail: this.logo }));
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent('company-theme-changed', { detail: defaultTheme }));
      } catch {}
    } catch (e) {
      this.colorError = 'Could not reset. Please try again.';
    } finally {
      this.saving = false;
    }
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
        this.hasChanges = true;
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

  private themesEqual(a: ThemeColors, b: ThemeColors): boolean {
    const keys: ThemeColorKey[] = ['primary', 'secondary', 'accent', 'background', 'text'];
    return keys.every((key) => a[key] === b[key]);
  }
}
