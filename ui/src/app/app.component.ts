import { Component, HostListener, OnDestroy } from '@angular/core';
import { ChangeDetectorRef } from '@angular/core';
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
export class AppComponent implements OnDestroy {
  hideMenu: boolean = false;
  currentCompanyId: string | null = null;
  companyLogo: string = '';
  companyProfileEnabled = false;
  showCompanyProfile = false;
  currentModule: 'inbox' | 'roles' | 'resumes' | 'boardroom' | 'work' = 'roles';
  backIcon: string = 'group_add';
  workEnabled = false;
  inboxEnabled = false;

  private fbApp = initializeApp(environment.firebase);
  private db = getFirestore(this.fbApp);

  private logoChangedHandler = (e: Event) => {
    try {
      const ce = e as CustomEvent<string>;
      const next = (ce && (ce as any).detail) || '';
      if (typeof next === 'string') {
        this.companyLogo = next;
        this.cdr.detectChanges();
      }
    } catch {}
  };

  constructor(private router: Router, private ui: UiStateService, private cdr: ChangeDetectorRef) {
    this.router.events.subscribe(() => {
      this.hideMenu =
        this.router.url === '/login' || this.router.url === '/register';
      this.updateCompanyContext();
    });
    this.ui.showCompanyProfile$.subscribe((v) => (this.showCompanyProfile = v));
    this.ui.companyProfileEnabled$.subscribe((v) => (this.companyProfileEnabled = v));
    this.ui.workEnabled$.subscribe((v) => (this.workEnabled = v));
    this.ui.currentModule$.subscribe((m) => {
      this.currentModule = m;
      this.backIcon =
        m === 'inbox'
          ? 'mail'
          : m === 'boardroom'
          ? 'forum'
          : m === 'roles'
          ? 'group_add'
          : m === 'work'
          ? 'task'
          : 'badge';
      if (m === 'inbox') this.inboxEnabled = true;
    });

    // Respond immediately when company profile updates the logo
    window.addEventListener('company-logo-changed', this.logoChangedHandler as EventListener);
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
    this.ui.setCurrentModule('inbox');
  }

  openBoardroom() {
    this.ui.setShowCompanyProfile(false);
    this.ui.setCurrentModule('boardroom');
  }

  openRoles() {
    this.ui.setShowCompanyProfile(false);
    this.ui.setCurrentModule('roles');
  }

  openResumes() {
    this.ui.setShowCompanyProfile(false);
    this.ui.setCurrentModule('resumes');
  }

  openWork() {
    this.ui.setShowCompanyProfile(false);
    this.ui.setCurrentModule('work');
  }

  // Back navigation from Company Profile to the active module
  openBackToModule() {
    switch (this.currentModule) {
      case 'roles':
        return this.openRoles();
      case 'resumes':
        return this.openResumes();
      case 'boardroom':
        return this.openBoardroom();
      case 'inbox':
        return this.openInbox();
      case 'work':
        return this.openWork();
      default:
        return this.openRoles();
    }
  }

  private async updateCompanyContext() {
    const m = this.router.url.match(/\/company\/([^\/]+)/);
    const companyId = m ? m[1] : null;
    this.currentCompanyId = companyId;
    this.companyLogo = '';
    this.companyProfileEnabled = false;
    this.inboxEnabled = false;
    this.ui.setCompanyProfileEnabled(false);
    if (!companyId) return;

    try {
      const snap = await getDoc(doc(this.db, 'companies', companyId));
      const data = snap.data() as any;
      this.companyLogo = data?.logo || '';

      this.companyProfileEnabled = true;
      this.ui.setCompanyProfileEnabled(true);

      try {
        const acceptedSnap = await getDocs(
          query(
            collection(this.db, `companies/${companyId}/products`),
            where('accepted', '==', true)
          )
        );
        this.inboxEnabled = !acceptedSnap.empty;
      } catch {}
      // view will refresh on next tick
    } catch (e) {
      // ignore
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('company-logo-changed', this.logoChangedHandler as EventListener);
  }
}
