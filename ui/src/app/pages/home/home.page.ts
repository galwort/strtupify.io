import { Component, OnInit } from '@angular/core';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, deleteDoc, doc } from 'firebase/firestore';
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

  constructor() {}

  async ngOnInit() {
    const companiesSnapshot = await getDocs(collection(db, 'companies'));
    this.companies = companiesSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async onDelete(event: Event, companyId: string) {
    event.stopPropagation();

    for (const top of ['products', 'roles']) {
      const snap = await getDocs(collection(db, 'companies', companyId, top));
      for (const d of snap.docs) await deleteDoc(d.ref);
    }

    const employeesSnap = await getDocs(collection(db, 'companies', companyId, 'employees'));
    for (const emp of employeesSnap.docs) {
      const skillsSnap = await getDocs(collection(emp.ref, 'skills'));
      for (const skill of skillsSnap.docs) await deleteDoc(skill.ref);
      await deleteDoc(emp.ref);
    }

    await deleteDoc(doc(db, 'companies', companyId));
    this.companies = this.companies.filter(c => c.id !== companyId);
  }
}
