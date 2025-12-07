import { Injectable } from '@angular/core';

export type ThemeColorKey = 'primary' | 'secondary' | 'accent' | 'background' | 'text';

export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly defaults: ThemeColors = {
    background: '#f8f9fa',
    primary: '#007aff',
    secondary: '#1e3a8a',
    accent: '#00c6a9',
    text: '#333',
  };

  getDefaultTheme(): ThemeColors {
    return { ...this.defaults };
  }

  normalizeTheme(colors?: Partial<ThemeColors> | null): ThemeColors {
    const input = colors || {};
    const primary = this.normalizeColor(input.primary, this.defaults.primary);
    return {
      primary,
      secondary: this.normalizeColor(input.secondary, this.defaults.secondary),
      accent: this.normalizeColor(input.accent, this.defaults.accent),
      background: this.normalizeColor(input.background, this.defaults.background),
      text: this.normalizeColor(input.text, this.defaults.text),
    };
  }

  applyTheme(colors?: Partial<ThemeColors> | null): ThemeColors {
    const normalized = this.normalizeTheme(colors);
    this.setCssVariables(normalized);
    return normalized;
  }

  applyCompanyTheme(companyData: any): ThemeColors {
    const stored = this.extractFromCompany(companyData);
    return this.applyTheme(stored);
  }

  resetTheme(): ThemeColors {
    return this.applyTheme(this.defaults);
  }

  extractFromCompany(data: any): Partial<ThemeColors> {
    if (!data || typeof data !== 'object') return {};
    const theme = (data as any).theme || (data as any).themeColors || {};
    const primary = this.firstColor([theme.primary, theme.main, (data as any).primaryColor]);
    const secondary = this.firstColor([theme.secondary, (data as any).secondaryColor]);
    const accent = this.firstColor([theme.accent, (data as any).accentColor]);
    const background = this.firstColor([theme.background, (data as any).backgroundColor]);
    const text = this.firstColor([theme.text, (data as any).textColor]);
    return { primary, secondary, accent, background, text };
  }

  private setCssVariables(colors: ThemeColors) {
    const root = document.documentElement;
    root.style.setProperty('--theme-background', colors.background);
    root.style.setProperty('--theme-primary', colors.primary);
    root.style.setProperty('--theme-secondary', colors.secondary);
    root.style.setProperty('--theme-accent', colors.accent);
    root.style.setProperty('--theme-text', colors.text);
  }

  private normalizeColor(value: any, fallback: string): string {
    const hex = this.toHex(value);
    if (hex) return hex;
    return fallback;
  }

  private toHex(value: any): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    const match = v.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (!match) return null;
    let hex = match[1];
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    return `#${hex.toLowerCase()}`;
  }

  private firstColor(values: any[]): string | undefined {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  }
}
