export interface FundingDecision {
  approved: boolean;
  amount: number;
  grace_period_days: number;
  first_payment: number;
  reason: string;
}

export function toFundingDecision(input: any): FundingDecision {
  const approved = !!input?.approved;
  return {
    approved,
    amount: approved ? Number(input?.amount || 0) : 0,
    grace_period_days: approved ? Number(input?.grace_period_days || 0) : 0,
    first_payment: approved ? Number(input?.first_payment || 0) : 0,
    reason: typeof input?.reason === 'string' ? input.reason.trim() : '',
  };
}

export function rejectedFundingDecision(reason: string): FundingDecision {
  return {
    approved: false,
    amount: 0,
    grace_period_days: 0,
    first_payment: 0,
    reason: reason.trim(),
  };
}
