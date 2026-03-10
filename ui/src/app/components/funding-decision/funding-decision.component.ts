import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { FundingDecision } from 'src/app/models/funding-decision.model';

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
  @Input() decision: FundingDecision | null = null;
  @Output() editApplication = new EventEmitter<void>();
  @Output() newApplication = new EventEmitter<void>();
  @Output() acceptLoan = new EventEmitter<void>();
  @Output() generateHighPotential = new EventEmitter<void>();
}
