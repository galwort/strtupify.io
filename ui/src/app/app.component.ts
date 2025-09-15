import { Component, HostListener } from '@angular/core';
import { Router } from '@angular/router';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { UiStateService } from './services/ui-state.service';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent {
  hideMenu: boolean = false;
  currentCompanyId: string | null = null;
  companyLogo: string = '';
  companyProfileEnabled = false;
  showCompanyProfile = false;

  private fbApp = initializeApp(environment.firebase);
  private db = getFirestore(this.fbApp);

  constructor(private router: Router, private ui: UiStateService) {
    this.router.events.subscribe(() => {
      this.hideMenu =
        this.router.url === '/login' || this.router.url === '/register';
      this.updateCompanyContext();
    });
    this.ui.showCompanyProfile$.subscribe((v) => (this.showCompanyProfile = v));
  }

  @HostListener('document:keydown', ['$event'])
  onGlobalKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;

    const target = event.target as HTMLElement | null;
    const replyBtn = document.querySelector('.reply-composer #send-reply-btn') as HTMLButtonElement | null;
    if (replyBtn) {
      event.preventDefault();
      event.stopPropagation();
      replyBtn.click();
      return;
    }
    const inReply = target && (target.closest ? (target.closest('.reply-composer') as HTMLElement | null) : null);
    if (inReply) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
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
      const anyBtn = root.querySelector(
        'button:not([disabled]):not(.google-btn):not(.secondary):not(.company-logo)'
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

    const scope = (document.querySelector('.ion-page.ion-page-invisible ~ .ion-page, .ion-page:not(.ion-page-hidden)') ||
      document.querySelector('ion-content') ||
      document.body) as ParentNode | null;
    clickButton(scope);
  }

  // Sidebar actions
  openCompanyProfile() {
    this.ui.setShowCompanyProfile(true);
  }

  openInbox() {
    this.ui.setShowCompanyProfile(false);
  }

  private async updateCompanyContext() {
    const m = this.router.url.match(/\/company\/([^\/]+)/);
    const companyId = m ? m[1] : null;
    this.currentCompanyId = companyId;
    this.companyLogo = '';
    this.companyProfileEnabled = false;
    if (!companyId) return;

    try {
      const snap = await getDoc(doc(this.db, 'companies', companyId));
      const data = snap.data() as any;
      this.companyLogo = data?.logo || '';

      const prodSnap = await getDocs(
        query(
          collection(this.db, `companies/${companyId}/products`),
          where('accepted', '==', true)
        )
      );
      this.companyProfileEnabled = !prodSnap.empty;
    } catch (e) {
      // ignore
    }
  }
}
