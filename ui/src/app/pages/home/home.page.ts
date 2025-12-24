import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  getDocs,
  deleteDoc,
  doc,
  setDoc,
  query,
  where,
  getDoc,
  updateDoc,
  arrayRemove,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { getAuth, onAuthStateChanged, User } from 'firebase/auth';

const app = initializeApp(environment.firebase);
const db = getFirestore(app);
const auth = getAuth(app);

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage implements OnInit, OnDestroy {
  companies: any[] = [];
  loading = true;
  deleteTotal = 0;
  deleteDone = 0;
  deletingId: string | null = null;
  private currentUser: User | null = null;
  private authUnsubscribe: (() => void) | null = null;

  constructor() {}

  async ngOnInit() {
    this.authUnsubscribe = onAuthStateChanged(auth, async (user) => {
      this.loading = true;
      this.currentUser = user;
      if (user) {
        await this.loadCompanies(user.uid);
      } else {
        this.companies = [];
        this.loading = false;
      }
    });

    const pendingId = localStorage.getItem('deletingCompanyId');
    if (pendingId) {
      const exists = this.companies.some((c) => c.id === pendingId);
      if (exists) {
        this.deletingId = pendingId;
        await this.deleteCompany(pendingId);
      } else {
        localStorage.removeItem('deletingCompanyId');
      }
    }
  }

  async ionViewWillEnter() {
    if (this.currentUser) {
      await this.loadCompanies(this.currentUser.uid, this.companies.length === 0);
    }
  }

  ngOnDestroy(): void {
    if (this.authUnsubscribe) {
      this.authUnsubscribe();
      this.authUnsubscribe = null;
    }
  }

  private async loadCompanies(userId: string, showLoading = true) {
    const shouldShowLoading = showLoading || this.companies.length === 0;
    if (shouldShowLoading) {
      this.loading = true;
    }
    try {
      const seen: Map<string, any> = new Map();

      const byMemberSnapshot = await getDocs(
        query(collection(db, 'companies'), where('memberIds', 'array-contains', userId))
      );
      byMemberSnapshot.docs.forEach((d) => {
        seen.set(d.id, { id: d.id, ...d.data() });
      });

      const byOwnerSnapshot = await getDocs(
        query(collection(db, 'companies'), where('ownerId', '==', userId))
      );
      byOwnerSnapshot.docs.forEach((d) => {
        if (!seen.has(d.id)) {
          seen.set(d.id, { id: d.id, ...d.data() });
        }
      });

      try {
        const userDoc = await getDoc(doc(db, 'users', userId));
        const companyIds: string[] = (userDoc.data() as any)?.companyIds || [];
        for (const companyId of companyIds) {
          if (seen.has(companyId)) continue;
          const companySnap = await getDoc(doc(db, 'companies', companyId));
          if (companySnap.exists()) {
            seen.set(companyId, { id: companyId, ...companySnap.data() });
          }
        }
      } catch {}

      this.companies = Array.from(seen.values());
    } finally {
      if (shouldShowLoading) {
        this.loading = false;
      }
    }
  }

  async onDelete(event: Event, companyId: string) {
    event.stopPropagation();
    this.deletingId = companyId;
    await this.deleteCompany(companyId);
  }

  private async deleteCompany(companyId: string) {
    this.deleteTotal = 0;
    this.deleteDone = 0;
    localStorage.setItem('deletingCompanyId', companyId);
    await setDoc(doc(db, 'companies', companyId), { deleting: true, ledgerEnabled: false }, { merge: true });

    const countDocs = async (): Promise<number> => {
      let total = 0;
      const topCols = ['products', 'roles', 'inbox', 'workitems'];
      for (const top of topCols) {
        const snap = await getDocs(collection(db, 'companies', companyId, top));
        total += snap.docs.length;
      }
      const employeesSnap = await getDocs(
        collection(db, 'companies', companyId, 'employees')
      );
      total += employeesSnap.docs.length;
      for (const emp of employeesSnap.docs) {
        const skillsSnap = await getDocs(collection(emp.ref, 'skills'));
        total += skillsSnap.docs.length;
      }
      total += 1; 
      return total;
    };

    this.deleteTotal = await countDocs();
    const bump = () => (this.deleteDone = Math.min(this.deleteDone + 1, this.deleteTotal));

    try {
      for (const top of ['products', 'roles', 'inbox', 'workitems']) {
        const snap = await getDocs(collection(db, 'companies', companyId, top));
        for (const d of snap.docs) {
          await deleteDoc(d.ref);
          bump();
        }
      }

      const employeesSnap = await getDocs(
        collection(db, 'companies', companyId, 'employees')
      );
      for (const emp of employeesSnap.docs) {
        const skillsSnap = await getDocs(collection(emp.ref, 'skills'));
        for (const skill of skillsSnap.docs) {
          await deleteDoc(skill.ref);
          bump();
        }
        await deleteDoc(emp.ref);
        bump();
      }

      await deleteDoc(doc(db, 'companies', companyId));
      bump();

      this.companies = this.companies.filter((c) => c.id !== companyId);
      try {
        if (this.currentUser) {
          await updateDoc(doc(db, 'users', this.currentUser.uid), {
            companyIds: arrayRemove(companyId),
          });
        }
      } catch {}
    } finally {
      setTimeout(() => {
        this.deleteTotal = 0;
        this.deleteDone = 0;
        this.deletingId = null;
      }, 300);
      localStorage.removeItem('deletingCompanyId');
    }
  }

  @HostListener('window:beforeunload', ['$event'])
  confirmUnload(event: BeforeUnloadEvent) {
    if (this.deleteTotal > 0 && this.deleteDone < this.deleteTotal) {
      event.preventDefault();
      event.returnValue = '';
    }
  }
}
