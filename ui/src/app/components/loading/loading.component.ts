import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-loading',
  templateUrl: './loading.component.html',
  styleUrls: ['./loading.component.scss'],
  imports: [CommonModule],
})
export class LoadingComponent implements OnInit {
  @Input() totalTasks = 0;
  @Input() completedTasks = 0;

  constructor() {}

  ngOnInit() {}
}
