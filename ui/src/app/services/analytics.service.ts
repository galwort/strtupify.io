import { Injectable } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs/operators';
import { environment } from '../../environments/environment';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private initialized = false;

  constructor(private router: Router) {}

  init(): void {
    const measurementId = environment?.firebase?.measurementId;
    if (!measurementId || this.initialized) return;
    this.initialized = true;

    // Load GA4 gtag script
    const gtagScript = document.createElement('script');
    gtagScript.async = true;
    gtagScript.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
    document.head.appendChild(gtagScript);

    window.dataLayer = window.dataLayer || [];
    window.gtag = (...args: unknown[]) => {
      (window.dataLayer as unknown[]).push(args);
    };
    window.gtag('js', new Date());
    window.gtag('config', measurementId, { send_page_view: false });

    // Initial page view + SPA route changes
    this.sendPageView(this.router.url);
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => this.sendPageView(event.urlAfterRedirects || event.url));
  }

  private sendPageView(path: string): void {
    if (!window.gtag || !path) return;
    window.gtag('event', 'page_view', {
      page_path: path,
      page_location: window.location.href,
    });
  }
}
