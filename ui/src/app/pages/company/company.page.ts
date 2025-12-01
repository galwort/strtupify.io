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
  setDoc,
  arrayUnion,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { getAuth, onAuthStateChanged, User } from 'firebase/auth';

export const app = initializeApp(environment.firebase);
export const db = getFirestore(app);
const auth = getAuth(app);

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
  showHr = false;
  showCalendar = false;
  totalTasks = 0;
  completedTasks = 0;
  companyId = '';
  showCompanyProfile = false;
  private currentUser: User | null = null;
  accessResolved = false;

  constructor(private router: Router, private ui: UiStateService) {}

  async ngOnInit() {
    const segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) {
      this.showLoading = false;
      return;
    }

    const resolvedUser = await this.resolveCurrentUser();
    if (!resolvedUser) {
      if (auth.currentUser) {
        this.router.navigate(['/home']);
      } else {
        this.router.navigate(['/login']);
      }
      this.showLoading = false;
      return;
    }
    this.currentUser = resolvedUser;
    this.accessResolved = true;

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
      this.showHr = m === 'hr';
      this.showCalendar = m === 'calendar';
      if (m === 'roles') {
        this.showWork = false;
        this.showInbox = false;
        this.showBoardroom = false;
        this.showResumes = false;
        this.showLedger = false;
        this.showHr = false;
        this.showCalendar = false;
      }
      if (m === 'hr') {
        this.showWork = false;
        this.showInbox = false;
        this.showBoardroom = false;
        this.showResumes = false;
        this.showLedger = false;
        this.showCalendar = false;
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
    this.showHr = false;
    this.showCalendar = false;
    if (!this.showLoading && !this.showBoardroom && !this.showInbox) {
      this.ui.setCurrentModule(this.showResumes ? 'resumes' : 'roles');
    }
  }

  openBoardroom() {
    this.showLoading = false;
    this.showResumes = false;
    this.showBoardroom = true;
    this.showHr = false;
    this.showCalendar = false;
    this.ui.setCompanyProfileEnabled(true);
    this.ui.setCurrentModule('boardroom');
  }

  openInbox() {
    this.showBoardroom = false;
    this.showInbox = true;
    this.showWork = false;
    this.showHr = false;
    this.showCalendar = false;
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

  private async resolveCurrentUser(): Promise<User | null> {
    const existing = auth.currentUser;
    if (existing) {
      const hasAccess = await this.ensureCompanyAccess(existing);
      return hasAccess ? existing : null;
    }

    return new Promise<User | null>((resolve) => {
      const unsubscribe = onAuthStateChanged(auth, async (user) => {
        unsubscribe();
        if (user) {
          const hasAccess = await this.ensureCompanyAccess(user);
          resolve(hasAccess ? user : null);
          return;
        }
        resolve(null);
      });
    });
  }

  private async ensureCompanyAccess(user: User): Promise<boolean> {
    try {
      const ref = doc(db, 'companies', this.companyId);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        return false;
      }
      const data = (snap.data() as any) || {};
      let members: string[] = Array.isArray(data.memberIds)
        ? [...data.memberIds]
        : [];

      const ownerId: string | undefined = data.ownerId;
      if (!members.length && ownerId) {
        members = [ownerId];
      }

      if (members.includes(user.uid)) {
        if (ownerId && ownerId === user.uid && (!data.memberIds || data.memberIds.length === 0)) {
          await updateDoc(ref, {
            memberIds: [user.uid],
            ownerEmail: data.ownerEmail || user.email || null,
          });
          await setDoc(
            doc(db, 'users', user.uid),
            {
              companyIds: arrayUnion(this.companyId),
            },
            { merge: true }
          );
        }
        return true;
      }

      if (!ownerId || ownerId === user.uid) {
        members = [...new Set([...members, user.uid])];
        await updateDoc(ref, {
          ownerId: ownerId || user.uid,
          ownerEmail: data.ownerEmail || user.email || null,
          memberIds: members,
        });
        await setDoc(
          doc(db, 'users', user.uid),
          {
            companyIds: arrayUnion(this.companyId),
          },
          { merge: true }
        );
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }
}
