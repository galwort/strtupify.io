import {
  Component,
  Input,
  OnChanges,
  OnInit,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpClientModule } from '@angular/common/http';

@Component({
  selector: 'app-loading',
  templateUrl: './loading.component.html',
  styleUrls: ['./loading.component.scss'],
  standalone: true,
  imports: [CommonModule, HttpClientModule],
})
export class LoadingComponent implements OnInit, OnChanges {
  @Input() totalTasks = 0;
  @Input() completedTasks = 0;

  statusMessage = 'Loading...';
  private buzzwords: string[] = [];
  private lastBucket = -1;

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.loadBuzzwords();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ('totalTasks' in changes || 'completedTasks' in changes) {
      this.updateStatus();
    }
  }

  get progressPercent(): number {
    if (this.totalTasks <= 0) return 0;
    const pct = (this.completedTasks / this.totalTasks) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  private loadBuzzwords() {
    this.http.get('assets/buzzwords.txt', { responseType: 'text' }).subscribe({
      next: (txt) => {
        this.buzzwords = txt
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        this.reapplyStatus();
      },
      error: () => {
        this.buzzwords = [];
      },
    });
  }

  private updateStatus() {
    if (this.totalTasks <= 0) {
      this.statusMessage = 'Loading...';
      this.lastBucket = -1;
      return;
    }
    const bucket = Math.floor(this.progressPercent / 20);
    if (bucket !== this.lastBucket || !this.statusMessage) {
      this.lastBucket = bucket;
      this.statusMessage = this.pickBuzzword();
    }
  }

  private reapplyStatus() {
    if (this.lastBucket >= 0) {
      this.statusMessage = this.pickBuzzword();
    }
  }

  private pickBuzzword(): string {
    const list = this.buzzwords.length ? this.buzzwords : ['Loading'];
    const choice = list[Math.floor(Math.random() * list.length)];
    return `${choice}...`;
  }
}
