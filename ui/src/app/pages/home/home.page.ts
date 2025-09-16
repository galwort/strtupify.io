import { Component, HostListener, OnInit } from '@angular/core';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  getDocs,
  deleteDoc,
  doc,
  setDoc,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

const app = initializeApp(environment.firebase);
const db = getFirestore(app);

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage implements OnInit {
  companies: any[] = [];
  deleteTotal = 0;
  deleteDone = 0;
  deletingId: string | null = null;

  constructor() {}

  async ngOnInit() {
    const companiesSnapshot = await getDocs(collection(db, 'companies'));
    this.companies = companiesSnapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));

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

  async onDelete(event: Event, companyId: string) {
    event.stopPropagation();
    this.deletingId = companyId;
    await this.deleteCompany(companyId);
  }

  private async deleteCompany(companyId: string) {
    this.deleteTotal = 0;
    this.deleteDone = 0;
    localStorage.setItem('deletingCompanyId', companyId);
    await setDoc(doc(db, 'companies', companyId), { deleting: true }, { merge: true });

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
      total += 1; // company doc itself
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
