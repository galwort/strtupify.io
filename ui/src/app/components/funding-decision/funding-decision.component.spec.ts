import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { FundingDecisionComponent } from './funding-decision.component';

describe('FundingDecisionComponent', () => {
  let component: FundingDecisionComponent;
  let fixture: ComponentFixture<FundingDecisionComponent>;

  beforeEach(waitForAsync(() => {
    TestBed.configureTestingModule({
      imports: [FundingDecisionComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(FundingDecisionComponent);
    component = fixture.componentInstance;
  }));

  it('renders the rejection reason under the rejected status', () => {
    component.companyName = 'Acme';
    component.decision = {
      approved: false,
      amount: 0,
      grace_period_days: 0,
      first_payment: 0,
      reason: 'The business does not show a credible path to near-term revenue.',
    };

    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const reason = root.querySelector('.rejection-reason');

    expect(root.textContent).toContain('Loan Rejected');
    expect(reason?.textContent).toContain(
      'The business does not show a credible path to near-term revenue.'
    );
  });
});
