import { Component, HostListener } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent {
  hideMenu: boolean = false;

  constructor(private router: Router) {
    this.router.events.subscribe(() => {
      this.hideMenu =
        this.router.url === '/login' || this.router.url === '/register';
    });
  }

  @HostListener('document:keydown', ['$event'])
  onGlobalKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;

    const target = event.target as HTMLElement | null;
    const form = target && (target.closest ? (target.closest('form') as HTMLFormElement | null) : null);

    const clickButton = (root: ParentNode | null): boolean => {
      if (!root) return false;
      const selectors = [
        'button[type="submit"]:not([disabled])',
        'input[type="submit"]:not([disabled])',
        'button.login-btn:not([disabled])',
      ];
      for (const sel of selectors) {
        const el = root.querySelector(sel) as HTMLElement | null;
        if (el) {
          event.preventDefault();
          event.stopPropagation();
          (el as HTMLButtonElement).click();
          return true;
        }
      }
      // Fallback: first enabled button that is not obviously a secondary action
      const anyBtn = root.querySelector(
        'button:not([disabled]):not(.google-btn):not(.secondary)'
      ) as HTMLElement | null;
      if (anyBtn) {
        event.preventDefault();
        event.stopPropagation();
        (anyBtn as HTMLButtonElement).click();
        return true;
      }
      return false;
    };

    if (form) {
      if (clickButton(form)) return;
      // Fall back to submitting the form to trigger (ngSubmit)
      event.preventDefault();
      event.stopPropagation();
      const f: any = form as any;
      if (typeof f.requestSubmit === 'function') {
        f.requestSubmit();
      } else {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
      return;
    }

    // No form found; try within the active page/content
    const scope = (document.querySelector('.ion-page.ion-page-invisible ~ .ion-page, .ion-page:not(.ion-page-hidden)') ||
      document.querySelector('ion-content') ||
      document.body) as ParentNode | null;
    clickButton(scope);
  }
}
