import { Component, HostListener, OnDestroy } from '@angular/core';
import { ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, collection, getDocs, query, where, onSnapshot, updateDoc, setDoc, arrayUnion } from 'firebase/firestore';
import { getAuth, onAuthStateChanged, Unsubscribe } from 'firebase/auth';
import { UiStateService } from './services/ui-state.service';
import { environment } from '../environments/environment';
import { EndgameService } from './services/endgame.service';
import { InboxService, Email } from './services/inbox.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent implements OnDestroy {
  hideMenu = false;
  currentCompanyId: string | null = null;
  companyLogo = '';
  companyProfileEnabled = false;
  showCompanyProfile = false;
  currentModule: 'inbox' | 'roles' | 'resumes' | 'boardroom' | 'work' | 'ledger' | 'hr' | 'calendar' = 'roles';
  backIcon: string = 'group_add';
  workEnabled = false;
  inboxEnabled = false;
  ledgerEnabled = false;
  hrEnabled = false;
  calendarEnabled = false;
  showBrandLogo = true;
  showAccountButton = false;
  isHomeRoute = false;
  isAccountRoute = false;
  endgameActive = false;
  endgameResetting = false;
  sidebarColor = 'var(--theme-primary)';
  newEmailToast: { from?: string; subject?: string; preview?: string } | null = null;
  private isAuthenticated = false;
  private endgameSub: Subscription | null = null;
  private inboxWatchSub: Subscription | null = null;
  private knownEmailIds = new Set<string>();
  private inboxWatchInitialized = false;
  private emailToastTimer: any = null;

  private fbApp = initializeApp(environment.firebase);
  private db = getFirestore(this.fbApp);
  private authUnsub: Unsubscribe | null = null;

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

  constructor(
    private router: Router,
    private ui: UiStateService,
    private cdr: ChangeDetectorRef,
    private endgame: EndgameService,
    private inbox: InboxService
  ) {
    this.router.events.subscribe(() => {
      this.hideMenu = this.router.url === '/login' || this.router.url === '/register';
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
          : m === 'calendar'
          ? 'event'
          : m === 'ledger'
          ? 'account_balance'
          : m === 'hr'
          ? 'diversity_3'
          : 'badge';
      if (m === 'inbox') {
        this.inboxEnabled = true;
        this.hideNewEmailToast();
      }
    });

    window.addEventListener('company-logo-changed', this.logoChangedHandler as EventListener);

    const auth = getAuth(this.fbApp);
    this.isAuthenticated = !!auth.currentUser;
    this.authUnsub = onAuthStateChanged(auth, (user) => {
      this.isAuthenticated = !!user;
      this.updateCompanyContext();
    });

    this.ui.hrEnabled$.subscribe((enabled) => {
      this.hrEnabled = enabled;
    });
    this.ui.calendarEnabled$.subscribe((enabled) => {
      this.calendarEnabled = enabled;
    });

    this.endgameSub = this.endgame.state$.subscribe((state) => {
      this.endgameActive = !!state.active;
      if (!state.active) {
        this.endgameResetting = false;
      }
      this.cdr.detectChanges();
    });
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

  openCompanyProfile() {
    this.ui.setShowCompanyProfile(true);
    this.ui.setCurrentModule('roles');
  }
  openInbox() {
    this.hideNewEmailToast();
    this.ui.setShowCompanyProfile(false);
    this.ui.setCurrentModule('inbox');
  }
  openBoardroom() { this.ui.setShowCompanyProfile(false); this.ui.setCurrentModule('boardroom'); }
  openRoles() { this.ui.setShowCompanyProfile(false); this.ui.setCurrentModule('roles'); }
  openResumes() { this.ui.setShowCompanyProfile(false); this.ui.setCurrentModule('resumes'); }
  openWork() { this.ui.setShowCompanyProfile(false); this.ui.setCurrentModule('work'); }
  openCalendar() { this.ui.setShowCompanyProfile(false); this.ui.setCurrentModule('calendar'); }
  openLedger() { this.ui.setShowCompanyProfile(false); this.ui.setCurrentModule('ledger'); }
  openHR() { this.ui.setShowCompanyProfile(false); this.ui.setCurrentModule('hr'); }

  openBackToModule() {
    switch (this.currentModule) {
      case 'hr': return this.openHR();
      case 'roles': return this.openRoles();
      case 'resumes': return this.openResumes();
      case 'boardroom': return this.openBoardroom();
      case 'inbox': return this.openInbox();
      case 'work': return this.openWork();
      case 'calendar': return this.openCalendar();
      case 'ledger': return this.openLedger();
      default: return this.openRoles();
    }
  }

  openAccount() {
    this.ui.setShowCompanyProfile(false);
    this.router.navigate(['/account']);
  }

  private hideNewEmailToast(): void {
    if (this.emailToastTimer) {
      clearTimeout(this.emailToastTimer);
      this.emailToastTimer = null;
    }
    if (this.newEmailToast) {
      this.newEmailToast = null;
      this.cdr.detectChanges();
    }
  }

  private showNewEmailToast(email: Email): void {
    if (!email) return;
    this.newEmailToast = {
      from: email.sender || 'New email',
      subject: email.subject || 'New email',
      preview: email.preview,
    };
    if (this.emailToastTimer) clearTimeout(this.emailToastTimer);
    this.emailToastTimer = setTimeout(() => {
      this.newEmailToast = null;
      this.emailToastTimer = null;
      this.cdr.detectChanges();
    }, 6000);
    this.cdr.detectChanges();
  }

  private startInboxWatcher(companyId: string | null): void {
    if (this.inboxWatchSub) {
      try {
        this.inboxWatchSub.unsubscribe();
      } catch {}
      this.inboxWatchSub = null;
    }
    this.knownEmailIds.clear();
    this.inboxWatchInitialized = false;
    this.hideNewEmailToast();
    if (!companyId) return;
    this.inboxWatchSub = this.inbox
      .getInbox(companyId)
      .subscribe((emails) => this.handleInboxSnapshot(emails || []));
  }

  private handleInboxSnapshot(emails: Email[]): void {
    if (!this.inboxWatchInitialized) {
      emails.forEach((e) => this.knownEmailIds.add(e.id));
      this.inboxWatchInitialized = true;
    }
    const fresh = emails.filter((e) => !this.knownEmailIds.has(e.id));
    emails.forEach((e) => this.knownEmailIds.add(e.id));
    if (!this.inboxEnabled || !fresh.length || this.currentModule === 'inbox')
      return;
    const ts = (e: Email) => {
      const t = new Date(e.timestamp || '').getTime();
      return Number.isFinite(t) ? t : 0;
    };
    const newest = fresh
      .slice()
      .sort((a, b) => ts(b) - ts(a))[0];
    if (newest) this.showNewEmailToast(newest);
  }

  private async updateCompanyContext() {
    const m = this.router.url.match(/\/company\/([^\/]+)/);
    const companyId = m ? m[1] : null;
    this.currentCompanyId = companyId;
    this.endgame.setCompany(companyId || '');
    this.companyLogo = '';
    this.companyProfileEnabled = false;
    this.inboxEnabled = false;
    this.ledgerEnabled = false;
    this.hrEnabled = false;
    this.calendarEnabled = false;
    this.ui.setCompanyProfileEnabled(false);
    this.ui.setHrEnabled(false);
    this.ui.setCalendarEnabled(false);
    this.startInboxWatcher(null);
    const currentUrl = this.router.url || '';
    this.isHomeRoute = currentUrl === '/home' || currentUrl.startsWith('/home?');
    this.isAccountRoute = currentUrl === '/account' || currentUrl.startsWith('/account/');
    this.showBrandLogo = !this.isHomeRoute;
    this.showAccountButton = this.isAuthenticated && !this.hideMenu && !this.isAccountRoute;
    try {
      const prevUnsub = (window as any).__companyDocUnsub as (() => void) | undefined;
      if (prevUnsub) prevUnsub();
      (window as any).__companyDocUnsub = undefined;
    } catch {}
    if (!companyId) return;

    try {
      const user = getAuth(this.fbApp).currentUser;
      if (!user) {
        this.router.navigate(['/login']);
        return;
      }

      const ref = doc(this.db, 'companies', companyId);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        this.router.navigate(['/home']);
        return;
      }
      const data = snap.data() as any;
      let members: string[] = Array.isArray(data?.memberIds) ? [...data.memberIds] : [];
      const ownerId: string | undefined = data?.ownerId;
      if (!members.includes(user.uid)) {
        if (ownerId && ownerId === user.uid) {
          members = [...members, user.uid];
          await updateDoc(ref, {
            memberIds: members,
            ownerEmail: data?.ownerEmail || user.email || null,
          });
          await setDoc(
            doc(this.db, 'users', user.uid),
            {
              companyIds: arrayUnion(companyId),
            },
            { merge: true }
          );
        } else {
          this.router.navigate(['/home']);
          return;
        }
      }
      this.companyLogo = data?.logo || '';
      this.companyProfileEnabled = true;
      this.ui.setCompanyProfileEnabled(true);
      try {
        const acceptedSnap = await getDocs(
          query(collection(this.db, `companies/${companyId}/products`), where('accepted', '==', true))
        );
        this.inboxEnabled = !acceptedSnap.empty;
      } catch {}
      this.startInboxWatcher(companyId);
      try {
        const unsub = onSnapshot(ref, (s) => {
          const d = (s && (s.data() as any)) || {};
          const le = !!d.ledgerEnabled;
          this.ledgerEnabled = le;
          const cal = !!d.calendarEnabled;
          this.calendarEnabled = cal;
          this.ui.setCalendarEnabled(cal);
          this.ui.setWorkEnabled(this.workEnabled);
        });
        (window as any).__companyDocUnsub = unsub;
      } catch {}
    } catch (e) {}
  }

  async handleEndgameReset(): Promise<void> {
    if (this.endgameResetting) return;
    this.endgameResetting = true;
    await this.endgame.completeResetFlow();
    this.endgameResetting = false;
    this.cdr.detectChanges();
  }

  ngOnDestroy(): void {
    window.removeEventListener('company-logo-changed', this.logoChangedHandler as EventListener);
    if (this.authUnsub) {
      this.authUnsub();
      this.authUnsub = null;
    }
    if (this.endgameSub) {
      try {
        this.endgameSub.unsubscribe();
      } catch {}
      this.endgameSub = null;
    }
    if (this.inboxWatchSub) {
      try {
        this.inboxWatchSub.unsubscribe();
      } catch {}
      this.inboxWatchSub = null;
    }
    if (this.emailToastTimer) {
      clearTimeout(this.emailToastTimer);
      this.emailToastTimer = null;
    }
  }
}
