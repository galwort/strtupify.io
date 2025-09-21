import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { UiStateService } from 'src/app/services/ui-state.service';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  updateDoc,
  onSnapshot,
  QuerySnapshot,
  DocumentData,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

export const app = initializeApp(environment.firebase);
export const db = getFirestore(app);

@Component({
  selector: 'app-company',
  templateUrl: './company.page.html',
  styleUrls: ['./company.page.scss'],
  standalone: false,
})
export class CompanyPage implements OnInit {
  showLoading = true;
  showResumes = false;
  showBoardroom = false;
  showInbox = false;
  showWork = false;
  showLedger = false;
  totalTasks = 0;
  completedTasks = 0;
  companyId = '';
  showCompanyProfile = false;

  constructor(private router: Router, private ui: UiStateService) {}

  async ngOnInit() {
    const segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) {
      this.showLoading = false;
      return;
    }

    this.ui.setCurrentModule('roles');

    this.ui.showCompanyProfile$.subscribe((v) => {
      this.showCompanyProfile = v;
    });
    this.ui.currentModule$.subscribe((m) => {
      if (!this.companyId) return;
      this.showWork = m === 'work';
      this.showInbox = m === 'inbox';
      this.showBoardroom = m === 'boardroom';
      this.showResumes = m === 'resumes';
      this.showLedger = m === 'ledger';
      if (m === 'roles') {
        this.showWork = false;
        this.showInbox = false;
        this.showBoardroom = false;
        this.showResumes = false;
        this.showLedger = false;
      }
    });

    const acceptedSnap = await getDocs(
      query(
        collection(db, `companies/${this.companyId}/products`),
        where('accepted', '==', true)
      )
    );
    if (!acceptedSnap.empty) {
      this.showInbox = true;
      this.showLoading = false;
      this.ui.setCompanyProfileEnabled(true);
      this.ui.setCurrentModule('inbox');

      await this.ensureFoundedAt();
      this.observeWorkItems();
      return;
    }

    const rolesSnap = await getDocs(
      collection(db, `companies/${this.companyId}/roles`)
    );
    const hasRoles = rolesSnap.docs.length > 0;
    const allFilled = hasRoles && rolesSnap.docs.every(
      (d) => (d.data() as any).openings === 0
    );
    if (allFilled) {
      this.showBoardroom = true;
      this.showLoading = false;
      this.ui.setCompanyProfileEnabled(true);
      this.ui.setCurrentModule('boardroom');
      return;
    }

    const employeesSnap = await getDocs(
      collection(db, `companies/${this.companyId}/employees`)
    );
    if (!employeesSnap.empty) this.showResumes = true;
    this.showLoading = false;
    this.ui.setCompanyProfileEnabled(true);
    this.ui.setCurrentModule(this.showResumes ? 'resumes' : 'roles');
    this.observeWorkItems();
  }

  handleLoadingState(e: {
    show: boolean;
    totalTasks: number;
    completedTasks: number;
    showResumes: boolean;
  }) {
    this.showLoading = e.show;
    this.totalTasks = e.totalTasks;
    this.completedTasks = e.completedTasks;
    this.showResumes = e.showResumes;
    if (!this.showLoading && !this.showBoardroom && !this.showInbox) {
      this.ui.setCurrentModule(this.showResumes ? 'resumes' : 'roles');
    }
  }

  openBoardroom() {
    this.showLoading = false;
    this.showResumes = false;
    this.showBoardroom = true;
    this.ui.setCompanyProfileEnabled(true);
    this.ui.setCurrentModule('boardroom');
  }

  openInbox() {
    this.showBoardroom = false;
    this.showInbox = true;
    this.showWork = false;
    this.ui.setCompanyProfileEnabled(true);
    this.ui.setCurrentModule('inbox');

    this.ensureFoundedAt();
  }

  private observeWorkItems() {
    try {
      const unsub = (window as any)._workitemsUnsub as (() => void) | undefined;
      if (unsub) unsub();
    } catch {}
    try {
      const ref = collection(db, `companies/${this.companyId}/workitems`);
      const unsubscribe = onSnapshot(ref, (snap: QuerySnapshot<DocumentData>) => {
        const has = snap.docs.length > 0;
        this.ui.setWorkEnabled(has);
      });
      (window as any)._workitemsUnsub = unsubscribe;
    } catch {}
  }

  private async ensureFoundedAt() {
    try {
      if (!this.companyId) return;
      const ref = doc(db, 'companies', this.companyId);
      const snap = await getDoc(ref);
      const data = (snap && (snap.data() as any)) || {};
      if (!data || data.founded_at) return;
      const todayIso = new Date().toISOString();
      await updateDoc(ref, { founded_at: todayIso });
    } catch {

    }
  }
}
