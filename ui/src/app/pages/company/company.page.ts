import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  getDocs,
  query,
  where,
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
  totalTasks = 0;
  completedTasks = 0;
  companyId = '';

  constructor(private router: Router) {}

  async ngOnInit() {
    const segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) {
      this.showLoading = false;
      return;
    }

    const acceptedSnap = await getDocs(
      query(
        collection(db, `companies/${this.companyId}/products`),
        where('accepted', '==', true)
      )
    );
    if (!acceptedSnap.empty) {
      this.showInbox = true;
      this.showLoading = false;
      return;
    }

    const rolesSnap = await getDocs(
      collection(db, `companies/${this.companyId}/roles`)
    );
    const allFilled = rolesSnap.docs.every(
      (d) => (d.data() as any).openings === 0
    );
    if (allFilled) {
      this.showBoardroom = true;
      this.showLoading = false;
      return;
    }

    const employeesSnap = await getDocs(
      collection(db, `companies/${this.companyId}/employees`)
    );
    if (!employeesSnap.empty) this.showResumes = true;
    this.showLoading = false;
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
  }

  openBoardroom() {
    this.showLoading = false;
    this.showResumes = false;
    this.showBoardroom = true;
  }

  openInbox() {
    this.showBoardroom = false;
    this.showInbox = true;
  }
}
