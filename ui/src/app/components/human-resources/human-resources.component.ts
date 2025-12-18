import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { initializeApp, getApps } from 'firebase/app';
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  QuerySnapshot,
  DocumentData,
  where,
  query,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import {
  AvatarMood,
  buildAvatarUrl,
  burnoutMood,
  normalizeAvatarMood,
  normalizeOutcomeStatus,
  outcomeMood,
} from 'src/app/utils/avatar';
import {
  fallbackEmployeeColor,
  normalizeEmployeeColor,
} from 'src/app/utils/employee-colors';

interface EmployeeSkill {
  id: string;
  name: string;
  level: number;
}

interface EmployeeProfile {
  id: string;
  name: string;
  title: string;
  stress: number;
  status: 'Active' | 'Burnout';
  load: number;
  description: string;
  salary: number;
  avatarName: string;
  avatarUrl: string;
  avatarMood: AvatarMood;
  burnout: boolean;
  gender?: string;
  color?: string;
  skills: EmployeeSkill[];
}

const fbApp = getApps().length
  ? getApps()[0]
  : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

@Component({
  selector: 'app-human-resources',
  standalone: true,
  templateUrl: './human-resources.component.html',
  styleUrls: ['./human-resources.component.scss'],
  imports: [CommonModule],
})
export class HumanResourcesComponent implements OnInit, OnDestroy {
  @Input() companyId = '';

  employees: EmployeeProfile[] = [];
  private unsub: (() => void) | null = null;
  private unsubCompany: (() => void) | null = null;
  private skillsToken = 0;
  focusPoints = 0;
  spendError = '';
  spending = false;
  refreshingRates = false;
  endgameOutcomeMood: AvatarMood | null = null;
  private tempAvatarMoods = new Map<
    string,
    { mood: AvatarMood; timeout?: any }
  >();
  private avatarColorCache = new Map<string, string>();
  private pendingAvatarFetches = new Map<string, Promise<void>>();
  private upgradingSkillKey: string | null = null;
  readonly skillPointCost = 10;

  ngOnInit(): void {
    if (!this.companyId) return;
    const companyRef = doc(db, `companies/${this.companyId}`);
    this.unsubCompany = onSnapshot(companyRef, (snap) => {
      const data = (snap && (snap.data() as any)) || {};
      const pts = Number(data.focusPoints || 0);
      this.focusPoints = Number.isFinite(pts)
        ? Math.max(0, Math.round(pts))
        : 0;
      const mood = this.extractOutcomeMood(data);
      if (mood !== this.endgameOutcomeMood) {
        this.endgameOutcomeMood = mood;
        this.refreshAllEmployeeAvatars();
      }
    });
    const ref = query(
      collection(db, `companies/${this.companyId}/employees`),
      where('hired', '==', true)
    );
    this.unsub = onSnapshot(ref, async (snap: QuerySnapshot<DocumentData>) => {
      const base = snap.docs
        .map((d) => {
          const data = (d.data() as any) || {};
          const stress = Math.max(0, Math.min(100, Number(data.stress || 0)));
          const status: 'Active' | 'Burnout' =
            String(data.status || 'Active') === 'Burnout'
              ? 'Burnout'
              : 'Active';
          const burnout = burnoutMood(stress, status) === 'sad';
          const load = Math.max(0, Number(data.load || 0));
          const salaryRaw = Number(data.salary || 0);
          const salary = Number.isFinite(salaryRaw)
            ? Math.max(0, salaryRaw)
            : 0;
          const description = String(
            data.description || data.personality || ''
          );
          const avatarName = String(
            data.avatar || data.photo || data.photoUrl || data.image || ''
          );
          const gender = String(data.gender || '').toLowerCase() || undefined;
          const color =
            normalizeEmployeeColor(data.calendarColor || data.color) ||
            fallbackEmployeeColor(d.id);
          const base: EmployeeProfile = {
            id: d.id,
            name: String(data.name || ''),
            title: String(data.title || ''),
            stress,
            status,
            load,
            salary,
            description,
            avatarName,
            avatarUrl: '',
            avatarMood: 'neutral',
            burnout,
            gender,
            color,
            skills: [],
          };
          return this.applyAvatarMood(base);
        })
        .sort((a, b) => b.stress - a.stress);

      this.employees = base;
      await this.loadSkills(base);
    });
  }

  ngOnDestroy(): void {
    if (this.unsub) this.unsub();
    if (this.unsubCompany) this.unsubCompany();
    this.tempAvatarMoods.forEach((entry) => {
      if (entry?.timeout) clearTimeout(entry.timeout);
    });
    this.tempAvatarMoods.clear();
  }

  statusLabel(emp: EmployeeProfile): string {
    if (emp.stress <= 10) return 'Has Bandwidth';
    if (emp.stress >= 90) return 'Burnout';
    return 'Active';
  }

  statusClass(emp: EmployeeProfile): 'bandwidth' | 'active' | 'burnout' {
    if (emp.stress <= 10) return 'bandwidth';
    if (emp.stress >= 90) return 'burnout';
    return 'active';
  }

  private computeAvatarMood(emp: EmployeeProfile): AvatarMood {
    const temp = this.tempAvatarMoods.get(emp.id);
    if (temp) return temp.mood;
    const burnout = burnoutMood(emp.stress, emp.status);
    if (burnout) return burnout;
    if (this.endgameOutcomeMood) return this.endgameOutcomeMood;
    return 'neutral';
  }

  private applyAvatarMood(emp: EmployeeProfile): EmployeeProfile {
    const burnout = burnoutMood(emp.stress, emp.status) === 'sad';
    const desiredMood = this.computeAvatarMood(emp);
    const avatarMood = normalizeAvatarMood(emp.avatarName, desiredMood);
    const color = normalizeEmployeeColor(emp.color);
    const baseUrl = buildAvatarUrl(emp.avatarName, avatarMood);
    const cacheKey = this.avatarCacheKey(emp, avatarMood, color || undefined);
    const cached = color ? this.avatarColorCache.get(cacheKey) : undefined;
    if (color && baseUrl && !cached) {
      void this.fetchAndColorAvatar(
        cacheKey,
        baseUrl,
        color,
        emp.id,
        avatarMood
      );
    }
    const avatarUrl = cached || baseUrl;
    return {
      ...emp,
      avatarMood,
      avatarUrl,
      burnout,
      color: color || emp.color,
    };
  }

  private avatarCacheKey(
    emp: EmployeeProfile,
    mood: AvatarMood,
    color?: string
  ): string {
    return `${emp.avatarName || ''}|${mood}|${color || ''}`;
  }

  private async fetchAndColorAvatar(
    cacheKey: string,
    url: string,
    color: string,
    empId: string,
    mood: AvatarMood
  ): Promise<void> {
    if (this.pendingAvatarFetches.has(cacheKey))
      return this.pendingAvatarFetches.get(cacheKey)!;
    const task = (async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`avatar_status_${resp.status}`);
        const svg = await resp.text();
        const updated = svg.replace(/#262E33/gi, color);
        const dataUri = this.svgToDataUri(updated);
        this.avatarColorCache.set(cacheKey, dataUri);
        this.refreshEmployeeAvatarWithCache(empId, cacheKey, dataUri, mood);
      } catch (err) {
        console.error('Failed to recolor avatar', err);
      } finally {
        this.pendingAvatarFetches.delete(cacheKey);
      }
    })();
    this.pendingAvatarFetches.set(cacheKey, task);
    return task;
  }

  private refreshEmployeeAvatarWithCache(
    empId: string,
    cacheKey: string,
    url: string,
    mood: AvatarMood
  ): void {
    this.employees = this.employees.map((emp) => {
      if (emp.id !== empId) return emp;
      const color = normalizeEmployeeColor(emp.color);
      const expectedKey = this.avatarCacheKey(emp, mood, color || undefined);
      if (expectedKey !== cacheKey) return emp;
      return { ...emp, avatarUrl: url, avatarMood: mood };
    });
  }

  private svgToDataUri(svg: string): string {
    const encoded = btoa(
      encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_match, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      )
    );
    return `data:image/svg+xml;base64,${encoded}`;
  }

  private refreshAllEmployeeAvatars(): void {
    this.employees = this.employees.map((emp) => this.applyAvatarMood(emp));
  }

  private refreshEmployeeAvatar(empId: string): void {
    this.employees = this.employees.map((emp) =>
      emp.id === empId ? this.applyAvatarMood(emp) : emp
    );
  }

  get isUpdating(): boolean {
    return this.spending || this.refreshingRates || !!this.upgradingSkillKey;
  }

  private setTemporaryAvatarMood(
    empId: string,
    mood: AvatarMood,
    durationMs = 1400
  ): void {
    const existing = this.tempAvatarMoods.get(empId);
    if (existing?.timeout) clearTimeout(existing.timeout);
    const timeout = setTimeout(() => {
      this.tempAvatarMoods.delete(empId);
      this.refreshEmployeeAvatar(empId);
    }, durationMs);
    this.tempAvatarMoods.set(empId, { mood, timeout });
    this.refreshEmployeeAvatar(empId);
  }

  private extractOutcomeMood(data: any): AvatarMood | null {
    const rawMood = this.normalizeMoodValue(
      data?.endgameOutcomeMood || data?.avatarMood
    );
    if (rawMood) return rawMood;
    const normalizedOutcome = normalizeOutcomeStatus(
      data?.endgameOutcome || data?.outcomeStatus || '',
      typeof data?.estimatedRevenue === 'number'
        ? data.estimatedRevenue
        : undefined
    );
    const mood = outcomeMood(normalizedOutcome);
    return mood === 'neutral' ? null : mood;
  }

  private normalizeMoodValue(value: any): AvatarMood | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim().toLowerCase();
    if (
      raw === 'happy' ||
      raw === 'sad' ||
      raw === 'angry' ||
      raw === 'neutral'
    )
      return raw as AvatarMood;
    return null;
  }

  async upgradeSkill(
    emp: EmployeeProfile,
    skill: EmployeeSkill
  ): Promise<void> {
    if (!this.companyId) return;
    if (this.spending) return;
    this.spendError = '';
    if (skill.level >= 10) {
      this.spendError = `${skill.name} is already at max level.`;
      return;
    }
    if (this.focusPoints < this.skillPointCost) {
      this.spendError = `You need ${this.skillPointCost.toLocaleString()} focus points to add a skill level.`;
      return;
    }
    const skillKey = this.buildSkillKey(emp.id, skill);
    this.upgradingSkillKey = skillKey;
    this.setTemporaryAvatarMood(emp.id, 'happy', 1800);
    this.spending = true;
    try {
      const nextLevel = await this.applySkillUpgrade(emp, skill);
      this.bumpLocalSkill(emp.id, skill.id, skill.name, nextLevel);
      this.focusPoints = Math.max(0, this.focusPoints - this.skillPointCost);
      await this.refreshRatesAfterSpend(emp, { ...skill, level: nextLevel });
    } catch (err: any) {
      const msg = typeof err?.message === 'string' ? err.message : '';
      if (msg === 'insufficient')
        this.spendError = 'Not enough focus points to spend.';
      else if (msg === 'max_level')
        this.spendError = `${skill.name} is already at max level.`;
      else this.spendError = 'Could not spend focus points right now.';
    } finally {
      this.upgradingSkillKey = null;
      this.spending = false;
    }
  }

  private bumpLocalSkill(
    empId: string,
    skillId: string,
    skillName: string,
    level: number
  ): void {
    this.employees = this.employees.map((emp) => {
      if (emp.id !== empId) return emp;
      const found = emp.skills?.some((s) => s.id === skillId);
      const skills = (emp.skills || []).map((s) =>
        s.id === skillId ? { ...s, level } : s
      );
      if (!found)
        skills.push({ id: skillId, name: skillName || 'Skill', level });
      return { ...emp, skills };
    });
  }

  private async applySkillUpgrade(
    emp: EmployeeProfile,
    skill: EmployeeSkill
  ): Promise<number> {
    if (!this.companyId) throw new Error('missing_company');
    const skillDocId =
      skill.id ||
      skill.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') ||
      'skill';
    const companyRef = doc(db, `companies/${this.companyId}`);
    const skillRef = doc(
      db,
      `companies/${this.companyId}/employees/${emp.id}/skills/${skillDocId}`
    );
    const nextLevel = await runTransaction(db, async (tx) => {
      const companySnap = await tx.get(companyRef);
      const data = (companySnap && (companySnap.data() as any)) || {};
      const currentPoints = Number.isFinite(Number(data.focusPoints))
        ? Math.max(0, Math.round(Number(data.focusPoints)))
        : 0;
      if (currentPoints < this.skillPointCost) throw new Error('insufficient');

      const skillSnap = await tx.get(skillRef);
      const skillData = (skillSnap && (skillSnap.data() as any)) || {};
      const existingRaw = Number(skillData.level ?? skill.level ?? 1);
      const existingLevel = Number.isFinite(existingRaw)
        ? Math.max(1, Math.min(10, Math.round(existingRaw)))
        : 1;
      if (existingLevel >= 10) throw new Error('max_level');
      const updatedLevel = Math.min(10, existingLevel + 1);

      tx.set(
        companyRef,
        {
          focusPoints: currentPoints - this.skillPointCost,
          focusPointsUpdatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      tx.set(
        skillRef,
        {
          skill: skill.name,
          level: updatedLevel,
          updated: serverTimestamp(),
        },
        { merge: true }
      );
      return updatedLevel;
    });
    return nextLevel;
  }

  private async refreshRatesAfterSpend(
    emp: EmployeeProfile,
    skill: EmployeeSkill
  ): Promise<void> {
    if (!this.companyId) return;
    this.refreshingRates = true;
    try {
      const payload = {
        company: this.companyId,
        trigger: 'focus_spend',
        employee_id: emp.id,
        skill_id: skill.id || '',
        skill_name: skill.name,
      };
      const resp = await fetch(
        'https://fa-strtupifyio.azurewebsites.net/api/focus_rates',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      await resp.json().catch(() => undefined);
    } catch (err) {
      console.error('Failed to refresh rates after focus spend', err);
      this.spendError =
        this.spendError ||
        'Skill applied but work rates may take longer to update.';
    } finally {
      this.refreshingRates = false;
    }
  }

  private async loadSkills(list: EmployeeProfile[]) {
    if (!this.companyId || !list.length) return;
    const token = ++this.skillsToken;
    const results = await Promise.all(
      list.map(async (emp) => {
        try {
          const snap = await getDocs(
            collection(
              db,
              `companies/${this.companyId}/employees/${emp.id}/skills`
            )
          );
          const skills: EmployeeSkill[] = snap.docs
            .map((d) => {
              const data = (d.data() as any) || {};
              const levelRaw = Number(data.level || 0);
              const level = Number.isFinite(levelRaw)
                ? Math.max(1, Math.min(10, levelRaw))
                : 1;
              const name = String(data.skill || '').trim();
              return name
                ? {
                    id: d.id,
                    name,
                    level,
                  }
                : null;
            })
            .filter((s): s is EmployeeSkill => !!s);
          return { id: emp.id, skills };
        } catch {
          return { id: emp.id, skills: [] as EmployeeSkill[] };
        }
      })
    );
    if (token !== this.skillsToken) return;
    const skillsById = new Map(results.map((r) => [r.id, r.skills]));
    this.employees = this.employees.map((emp) => {
      const skills = skillsById.get(emp.id);
      return skills ? { ...emp, skills } : emp;
    });
  }

  isSkillUpdating(emp: EmployeeProfile, skill: EmployeeSkill): boolean {
    return this.upgradingSkillKey === this.buildSkillKey(emp.id, skill);
  }

  private buildSkillKey(empId: string, skill: EmployeeSkill): string {
    const skillId =
      skill.id ||
      skill.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') ||
      'skill';
    return `${empId}|${skillId}`;
  }
}
