import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
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
  showLoading = false;
  showResumes = false;
  totalTasks = 0;
  completedTasks = 0;
  companyId = '';

  constructor(private router: Router) {}

  async ngOnInit() {
    let segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) return;
    let employeesQuery = await getDocs(
      collection(db, 'companies/' + this.companyId + '/employees')
    );
    let rolesQuery = await getDocs(
      collection(db, 'companies/' + this.companyId + '/roles')
    );
    if (!employeesQuery.empty) {
      this.showResumes = true;
    } else if (!rolesQuery.empty) {
      this.showResumes = false;
    }
  }

  handleLoadingState(event: {
    show: boolean;
    totalTasks: number;
    completedTasks: number;
    showResumes: boolean;
  }) {
    this.showLoading = event.show;
    this.totalTasks = event.totalTasks;
    this.completedTasks = event.completedTasks;
    this.showResumes = event.showResumes;
  }
}
