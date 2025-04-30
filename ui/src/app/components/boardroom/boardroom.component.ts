import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardroomService } from '../../services/boardroom.service';

@Component({
  selector: 'app-boardroom',
  templateUrl: './boardroom.component.html',
  styleUrls: ['./boardroom.component.scss'],
  imports: [CommonModule]
})
export class BoardroomComponent implements OnInit {
  @Input() companyId = '';
  productId = '';
  transcript: { speaker: string; line: string }[] = [];
  outcome = { name: '', description: '' };
  stage = 'INTRODUCTION';
  busy = false;
  finished = false;

  constructor(private api: BoardroomService) {}

  ngOnInit() {
    this.api.start(this.companyId).subscribe(r => {
      this.productId = r.productId;
      this.transcript.push({ speaker: r.speaker, line: r.line });
    });
  }

  next() {
    if (this.busy || this.finished) return;
    this.busy = true;
    this.api
      .step(this.companyId, this.productId, this.stage, this.transcript.length)
      .subscribe(r => {
        this.transcript.push({ speaker: r.speaker, line: r.line });
        this.outcome = { name: r.outcome.product, description: r.outcome.description };
        this.stage = r.stage;
        this.finished = r.done;
        this.busy = false;
      });
  }
}
