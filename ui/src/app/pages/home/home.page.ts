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
    this.companies = companiesSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  }

  async onDelete(event: Event, companyId: string) {
    event.stopPropagation();
    // remove from Firestore
    await deleteDoc(doc(db, 'companies', companyId));
    // update local list
    this.companies = this.companies.filter(c => c.id !== companyId);
  }
}
