import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'app-company',
  templateUrl: './company.page.html',
  styleUrls: ['./company.page.scss'],
  standalone: false,
})
export class CompanyPage implements OnInit {
  showLoading = false;
  totalTasks = 0;
  completedTasks = 0;

  constructor() {}

  ngOnInit() {}

  handleLoadingState(event: {
    show: boolean;
    totalTasks: number;
    completedTasks: number;
  }) {
    this.showLoading = event.show;
    this.totalTasks = event.totalTasks;
    this.completedTasks = event.completedTasks;
  }
}
