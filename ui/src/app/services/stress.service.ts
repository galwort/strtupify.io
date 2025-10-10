export type EmployeeStatus = 'Active' | 'Burnout';

export interface StressMetrics {
  load: number;
  stress: number;
  status: EmployeeStatus;
  multiplier: number;
}

const BURNOUT_THRESHOLD = 85;
const MAX_STRESS = 100;
const BASE_STRESS = 5;
const STRESS_PER_TASK = 20;

export function computeStressMetrics(taskCount: number): StressMetrics {
  const load = Math.max(0, Math.floor(taskCount || 0));
  const stressRaw = load <= 0 ? 0 : BASE_STRESS + STRESS_PER_TASK * load;
  const stress = Math.min(MAX_STRESS, Math.max(0, stressRaw));
  const status: EmployeeStatus = stress >= BURNOUT_THRESHOLD ? 'Burnout' : 'Active';
  const multiplier = status === 'Burnout' ? Number.POSITIVE_INFINITY : 1 + stress / 100;

  return { load, stress, status, multiplier };
}

export function getStressMultiplier(stress: number, status: EmployeeStatus): number {
  if (status === 'Burnout') return Number.POSITIVE_INFINITY;
  const safeStress = Math.min(MAX_STRESS, Math.max(0, Number(stress) || 0));
  return 1 + safeStress / 100;
}

export function isBurnedOut(status: EmployeeStatus | string): boolean {
  return String(status || '').toLowerCase() === 'burnout';
}

export const STRESS_BURNOUT_THRESHOLD = BURNOUT_THRESHOLD;
