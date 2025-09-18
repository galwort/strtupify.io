import {
  Component,
  Input,
  OnInit,
  ViewChild,
  ElementRef,
  AfterViewInit,
  ChangeDetectorRef,
  Output,
  EventEmitter,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardroomService } from '../../services/boardroom.service';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, updateDoc } from 'firebase/firestore';
import { environment } from 'src/environments/environment';

const fbApp = initializeApp(environment.firebase);
const db = getFirestore(fbApp);

@Component({
  selector: 'app-boardroom',
  templateUrl: './boardroom.component.html',
  styleUrls: ['./boardroom.component.scss'],
  standalone: true,
  imports: [CommonModule],
})
export class BoardroomComponent implements OnInit, AfterViewInit {
  @Input() companyId = '';
  @Output() acceptedProduct = new EventEmitter<void>();
  @ViewChild('scrollBox') private scrollBox!: ElementRef<HTMLDivElement>;

  productId = '';
  transcript: { speaker: string; line: string }[] = [];
  outcome = { name: '', description: '' };
  stage = 'INTRODUCTION';
  busy = false;
  finished = false;
  typing = false;

  constructor(private api: BoardroomService, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.api.start(this.companyId).subscribe((r) => {
      this.productId = r.productId;
      this.transcript.push({ speaker: r.speaker, line: r.line });
      setTimeout(() => this.scrollToBottom());
      this.next();
    });
  }

  ngAfterViewInit() {
    this.scrollToBottom();
  }

  next() {
    if (this.busy || this.finished) return;
    this.busy = true;
    this.typing = true;
    this.cdr.detectChanges();
    this.scrollToBottom();

    setTimeout(() => {
      this.api
        .step(
          this.companyId,
          this.productId,
          this.stage,
          this.transcript.length
        )
        .subscribe((r) => {
          this.typing = false;
          this.transcript.push({ speaker: r.speaker, line: r.line });
          this.outcome = {
            name: r.outcome.product,
            description: r.outcome.description,
          };
          this.stage = r.stage;
          this.finished = r.done;
          this.busy = false;
          setTimeout(() => this.scrollToBottom());
          if (!this.finished) {
            setTimeout(() => this.next(), 1000);
          }
        });
    }, 1000);
  }

  restart() {
    this.transcript = [];
    this.outcome = { name: '', description: '' };
    this.stage = 'INTRODUCTION';
    this.busy = false;
    this.finished = false;
    this.typing = false;

    this.api.start(this.companyId).subscribe((r) => {
      this.productId = r.productId;
      this.transcript.push({ speaker: r.speaker, line: r.line });
      setTimeout(() => this.scrollToBottom());
      this.next();
    });
  }

  async accept() {
    await updateDoc(
      doc(db, `companies/${this.companyId}/products/${this.productId}`),
      { accepted: true }
    );
    this.acceptedProduct.emit();
  }

  private scrollToBottom(): void {
    const box = this.scrollBox.nativeElement;
    box.scrollTop = box.scrollHeight;
  }
}
