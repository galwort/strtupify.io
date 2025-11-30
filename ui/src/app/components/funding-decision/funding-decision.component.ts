import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-funding-decision',
  templateUrl: './funding-decision.component.html',
  styleUrls: ['./funding-decision.component.scss'],
  standalone: true,
  imports: [CommonModule, IonicModule],
})
export class FundingDecisionComponent {
  @Input() companyName = '';
  @Input() logo = '';
  @Input() decision: { approved: boolean; amount: number; grace_period_days: number; first_payment: number } | null = null;
  @Output() editApplication = new EventEmitter<void>();
  @Output() newApplication = new EventEmitter<void>();
  @Output() acceptLoan = new EventEmitter<void>();
  @Output() generateHighPotential = new EventEmitter<void>();
}
