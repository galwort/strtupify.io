import {
  Component,
  EnvironmentInjector,
  OnDestroy,
  OnInit,
  runInInjectionContext,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import firebase from 'firebase/compat/app';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { firstValueFrom, of, Subscription } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { getApps, initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  setDoc,
  Timestamp,
  where,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { ThemeColors, ThemeService } from '../../services/theme.service';
import { STRESS_BURNOUT_THRESHOLD } from '../../services/stress.service';
import { normalizeOutcomeStatus } from '../../utils/avatar';

interface AccountProfile {
  email?: string | null;
  username?: string | null;
  loginUsername?: string | null;
  companyIds?: string[];
  createdAt?: any;
  achievements?: StoredAchievement[];
}

interface AccountViewModel {
  user: firebase.User;
  profile: AccountProfile | null;
}

type AchievementKey =
  | 'taskmaster'
  | 'rockstar'
  | 'midnightOil'
  | 'rebrand'
  | 'mogul'
  | 'toxic'
  | 'marketFitted'
  | 'eol'
  | 'aiIdeation'
  | 'headhunter'
  | 'integrityProblem'
  | 'banned'
  | 'transcendentalist'
  | 'nepoBaby';

type AchievementBadge = {
  key: AchievementKey;
  name: string;
  description: string;
  imageUrl: string;
  earnedAt?: Date | null;
};

type AchievementState = {
  taskmasterCount: number;
  rockstar: boolean;
  midnightOil: boolean;
  rebrand: boolean;
  companyCount: number;
  toxic: boolean;
  marketFitted: boolean;
  eol: boolean;
  aiIdeation: boolean;
  headhunter: boolean;
  integrityProblem: boolean;
  banned: boolean;
  transcendentalist: boolean;
  nepoBaby: boolean;
};

type StoredAchievement = {
  key: AchievementKey;
  earnedAt?: any;
};

const ACHIEVEMENT_DEFINITIONS: Record<
  AchievementKey,
  { name: string; description: string }
> = {
  taskmaster: { name: 'Taskmaster', description: 'Complete 100 tasks' },
  rockstar: { name: 'Rockstar', description: "Max out an employee's skills" },
  midnightOil: {
    name: 'Midnight Oil',
    description: 'Ask employee to work off hours',
  },
  rebrand: { name: 'Rebrand', description: 'Change the logo or colors' },
  mogul: { name: 'Mogul', description: 'Start multiple companies' },
  toxic: { name: 'Toxic', description: 'Burnout an employee' },
  marketFitted: {
    name: 'Market Fitted',
    description: 'Have a successful company',
  },
  eol: {
    name: 'EOL',
    description: 'Have a failed company',
  },
  aiIdeation: {
    name: 'AI Ideation',
    description: 'Submit an AI generated idea',
  },
  headhunter: { name: 'Headhunter', description: 'Hire an AI employee' },
  integrityProblem: {
    name: 'The Integrity Problem',
    description: 'Max out the insanity of Jeff',
  },
  banned: { name: 'Banned', description: 'Cancel SuperEats' },
  transcendentalist: {
    name: 'Transcendentalist',
    description: 'Score 280 focus points in one week',
  },
  nepoBaby: { name: 'Nepo Baby', description: 'Receive money from mom' },
};

const ACHIEVEMENT_ORDER: AchievementKey[] = [
  'taskmaster',
  'rockstar',
  'midnightOil',
  'rebrand',
  'mogul',
  'toxic',
  'marketFitted',
  'eol',
  'aiIdeation',
  'headhunter',
  'integrityProblem',
  'banned',
  'transcendentalist',
  'nepoBaby',
];

@Component({
  selector: 'app-account',
  templateUrl: './account.page.html',
  styleUrls: ['./account.page.scss'],
  standalone: false,
})
export class AccountPage implements OnInit, OnDestroy {
  viewModel: AccountViewModel | null = null;
  loading = true;
  errorMessage = '';
  signingOut = false;
  achievements: AchievementBadge[] = [];
  achievementsLoading = false;
  activeBadge: AchievementBadge | null = null;

  private authSub: Subscription | null = null;
  private profileSub: Subscription | null = null;
  private fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
  private db = getFirestore(this.fbApp);
  private badgeSvgTemplate: string | null = null;
  private achievementLoadToken = 0;
  private destroyed = false;
  private readonly defaultTheme: ThemeColors;

  constructor(
    private afAuth: AngularFireAuth,
    private firestore: AngularFirestore,
    private authService: AuthService,
    private router: Router,
    private environmentInjector: EnvironmentInjector,
    private http: HttpClient,
    private theme: ThemeService
  ) {
    this.defaultTheme = this.theme.getDefaultTheme();
  }

  ngOnInit(): void {
    this.authSub = this.afAuth.authState.subscribe((user) => {
      if (!user) {
        this.loading = false;
        this.viewModel = null;
        this.errorMessage = '';
        this.achievements = [];
        this.activeBadge = null;
        this.achievementLoadToken++;
        this.teardownProfile();
        this.router.navigate(['/login']);
        return;
      }

      this.bindProfile(user);
    });
  }

  ngOnDestroy(): void {
    if (this.authSub) {
      this.authSub.unsubscribe();
      this.authSub = null;
    }
    this.teardownProfile();
    this.destroyed = true;
  }

  async signOut() {
    if (this.signingOut) return;
    this.signingOut = true;
    this.errorMessage = '';
    try {
      await this.authService.logout();
      await this.router.navigate(['/login']);
    } catch (error: any) {
      console.error(error);
      this.errorMessage =
        error?.message || 'Failed to sign out. Please try again later.';
    } finally {
      this.signingOut = false;
    }
  }

  openBadgeModal(badge: AchievementBadge): void {
    this.activeBadge = badge;
  }

  closeBadgeModal(): void {
    this.activeBadge = null;
  }

  private bindProfile(user: firebase.User) {
    this.teardownProfile();
    this.loading = true;
    this.errorMessage = '';

    const profileDoc = runInInjectionContext(
      this.environmentInjector,
      () => this.firestore.doc<AccountProfile>(`users/${user.uid}`)
    );

    this.profileSub = profileDoc
      .valueChanges()
      .pipe(
        map((profile) => profile || null),
        catchError((error) => {
          console.error('Failed to load account', error);
          this.errorMessage =
            'Unable to load your account right now. Please try again later.';
          return of(null);
        })
      )
      .subscribe((profile) => {
        this.viewModel = { user, profile };
        this.loading = false;
        void this.loadAchievements(user, profile);
      });
  }

  private teardownProfile() {
    if (this.profileSub) {
      this.profileSub.unsubscribe();
      this.profileSub = null;
    }
  }

  private async loadAchievements(
    user: firebase.User | null,
    profile: AccountProfile | null
  ): Promise<void> {
    if (!user) {
      this.achievements = [];
      this.activeBadge = null;
      this.achievementLoadToken++;
      return;
    }
    const token = ++this.achievementLoadToken;
    this.achievementsLoading = true;
    try {
      const achievements = await this.computeAchievements(user, profile);
      if (token === this.achievementLoadToken && !this.destroyed) {
        this.achievements = achievements;
      }
    } catch (err) {
      console.error('Failed to load achievements', err);
      if (token === this.achievementLoadToken) this.achievements = [];
    } finally {
      if (token === this.achievementLoadToken) {
        this.achievementsLoading = false;
      }
    }
  }

  private async computeAchievements(
    user: firebase.User,
    profile: AccountProfile | null
  ): Promise<AchievementBadge[]> {
    const stored = this.normalizeStoredAchievements(profile);
    const companyIds = await this.collectCompanyIds(user, profile);
    const earnedKeys = companyIds.length
      ? await this.computeCompanyAchievementKeys(companyIds)
      : [];

    const { achievements, changed } = this.mergeAchievements(stored, earnedKeys);
    if (changed) {
      await this.persistAchievements(user.uid, achievements);
    }

    if (!achievements.length) return [];
    const template = await this.loadBadgeTemplate();
    return this.toAchievementBadges(achievements, template);
  }

  private async computeCompanyAchievementKeys(
    companyIds: string[]
  ): Promise<AchievementKey[]> {
    const state: AchievementState = {
      taskmasterCount: 0,
      rockstar: false,
      midnightOil: false,
      rebrand: false,
      companyCount: 0,
      toxic: false,
      marketFitted: false,
      eol: false,
      aiIdeation: false,
      headhunter: false,
      integrityProblem: false,
      banned: false,
      transcendentalist: false,
      nepoBaby: false,
    };

    for (const companyId of companyIds) {
      try {
        const snap = await getDoc(doc(this.db, 'companies', companyId));
        if (!snap.exists()) continue;
        state.companyCount += 1;
        const data = snap.data() as any;
        this.applyCompanyAchievements(data, state);
        await this.evaluateWorkItems(companyId, state);
        await this.evaluateEmployees(companyId, state);
      } catch (err) {
        console.error(`Failed to load company data for ${companyId}`, err);
      }
    }

    return this.extractAchievementKeys(state);
  }

  private extractAchievementKeys(state: AchievementState): AchievementKey[] {
    const earnedKeys: AchievementKey[] = [];
    if (state.taskmasterCount >= 100) earnedKeys.push('taskmaster');
    if (state.rockstar) earnedKeys.push('rockstar');
    if (state.midnightOil) earnedKeys.push('midnightOil');
    if (state.rebrand) earnedKeys.push('rebrand');
    if (state.companyCount >= 2) earnedKeys.push('mogul');
    if (state.toxic) earnedKeys.push('toxic');
    if (state.marketFitted) earnedKeys.push('marketFitted');
    if (state.eol) earnedKeys.push('eol');
    if (state.aiIdeation) earnedKeys.push('aiIdeation');
    if (state.headhunter) earnedKeys.push('headhunter');
    if (state.integrityProblem) earnedKeys.push('integrityProblem');
    if (state.banned) earnedKeys.push('banned');
    if (state.transcendentalist) earnedKeys.push('transcendentalist');
    if (state.nepoBaby) earnedKeys.push('nepoBaby');
    return earnedKeys;
  }

  private mergeAchievements(
    stored: StoredAchievement[],
    computedKeys: AchievementKey[]
  ): { achievements: StoredAchievement[]; changed: boolean } {
    const byKey = new Map<AchievementKey, StoredAchievement>();
    const normalizedStored = Array.isArray(stored) ? stored : [];
    const seenStored = new Set<AchievementKey>();
    normalizedStored.forEach((entry) => {
      if (!entry || !this.isAchievementKey(entry.key) || seenStored.has(entry.key)) {
        return;
      }
      seenStored.add(entry.key);
      byKey.set(entry.key, { key: entry.key, earnedAt: entry.earnedAt ?? null });
    });

    let changed = false;
    const now = Timestamp.fromDate(new Date());
    computedKeys.forEach((key) => {
      if (!byKey.has(key)) {
        byKey.set(key, { key, earnedAt: now });
        changed = true;
      }
    });

    const achievements = ACHIEVEMENT_ORDER.filter((key) => byKey.has(key)).map(
      (key) => byKey.get(key) as StoredAchievement
    );
    return { achievements, changed };
  }

  private async persistAchievements(
    userId: string,
    achievements: StoredAchievement[]
  ): Promise<void> {
    try {
      await setDoc(
        doc(this.db, 'users', userId),
        { achievements },
        { merge: true }
      );
    } catch (err) {
      console.error('Failed to persist achievements', err);
    }
  }

  private normalizeStoredAchievements(
    profile: AccountProfile | null
  ): StoredAchievement[] {
    if (!profile?.achievements || !Array.isArray(profile.achievements)) return [];
    const seen = new Set<AchievementKey>();
    return profile.achievements.reduce<StoredAchievement[]>((list, entry: any) => {
      const key = entry?.key;
      if (!this.isAchievementKey(key) || seen.has(key)) return list;
      seen.add(key);
      list.push({ key, earnedAt: entry?.earnedAt ?? null });
      return list;
    }, []);
  }

  private toAchievementBadges(
    achievements: StoredAchievement[],
    template: string | null
  ): AchievementBadge[] {
    const imageFor = (name: string) => this.renderBadge(name, template);
    return achievements
      .filter((a) => this.isAchievementKey(a.key))
      .map((achievement) => {
        const def = ACHIEVEMENT_DEFINITIONS[achievement.key];
        return {
          key: achievement.key,
          name: def.name,
          description: def.description,
          imageUrl: imageFor(def.name),
          earnedAt: this.asDate(achievement.earnedAt),
        };
      });
  }

  private isAchievementKey(value: any): value is AchievementKey {
    return ACHIEVEMENT_ORDER.includes(value as AchievementKey);
  }

  private asDate(value: any): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    try {
      if (typeof value?.toDate === 'function') {
        const converted = value.toDate();
        return converted instanceof Date && !Number.isNaN(converted.getTime())
          ? converted
          : null;
      }
    } catch {}
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private async collectCompanyIds(
    user: firebase.User,
    profile: AccountProfile | null
  ): Promise<string[]> {
    const ids = new Set<string>();
    (profile?.companyIds || []).forEach((id) => {
      if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    });
    try {
      const memberSnap = await getDocs(
        query(
          collection(this.db, 'companies'),
          where('memberIds', 'array-contains', user.uid)
        )
      );
      memberSnap.forEach((d) => ids.add(d.id));
    } catch {}

    try {
      const ownerSnap = await getDocs(
        query(collection(this.db, 'companies'), where('ownerId', '==', user.uid))
      );
      ownerSnap.forEach((d) => ids.add(d.id));
    } catch {}

    return Array.from(ids);
  }

  private applyCompanyAchievements(data: any, state: AchievementState): void {
    const outcome = normalizeOutcomeStatus(
      data?.endgameOutcome || data?.outcomeStatus || '',
      typeof data?.estimatedRevenue === 'number' ? data.estimatedRevenue : undefined
    );
    if (outcome === 'success') state.marketFitted = true;
    if (outcome === 'failure') state.eol = true;

    const jeffCount = Math.max(
      this.safeInt(data?.cadabraJeffCount),
      this.safeInt(data?.cadabraReplyCount)
    );
    if (jeffCount >= 5) state.integrityProblem = true;

    const stage = this.safeInt(data?.superEatsCancelStage);
    const supereatsCancelled = data?.superEatsCancelled === true || stage >= 4;
    if (supereatsCancelled) state.banned = true;

    const lastFocus = this.safeInt(data?.lastFocusPointsEarned);
    if (lastFocus >= 280) state.transcendentalist = true;

    if (data?.momGiftGranted === true) state.nepoBaby = true;

    const desc = String(data?.description || '').toLowerCase();
    if (desc.startsWith('using the power of ai')) {
      state.aiIdeation = true;
    }

    if (!state.rebrand) {
      state.rebrand = this.isRebranded(data);
    }
  }

  private async evaluateWorkItems(
    companyId: string,
    state: AchievementState
  ): Promise<void> {
    try {
      const snap = await getDocs(collection(this.db, `companies/${companyId}/workitems`));
      snap.forEach((d) => {
        const status = String((d.data() as any)?.status || '').toLowerCase();
        if (status === 'done') state.taskmasterCount += 1;
      });
    } catch (err) {
      console.error(`Failed to evaluate work items for ${companyId}`, err);
    }
  }

  private async evaluateEmployees(
    companyId: string,
    state: AchievementState
  ): Promise<void> {
    try {
      const snap = await getDocs(
        query(
          collection(this.db, `companies/${companyId}/employees`),
          where('hired', '==', true)
        )
      );
      for (const docSnap of snap.docs) {
        const data = (docSnap.data() as any) || {};
        const status = String(data.status || '').toLowerCase();
        const stress = this.safeNumber(data.stress);
        if (status === 'burnout' || stress >= STRESS_BURNOUT_THRESHOLD) {
          state.toxic = true;
        }
        const offHoursAllowed =
          data.offHoursAllowed === true || data.off_hours_allowed === true;
        if (offHoursAllowed) state.midnightOil = true;
        if (this.isAiEmployee(data)) state.headhunter = true;

        if (!state.rockstar) {
          const hasMaxSkills = await this.employeeHasMaxSkills(companyId, docSnap.id);
          if (hasMaxSkills) state.rockstar = true;
        }
        if (
          state.rockstar &&
          state.midnightOil &&
          state.toxic &&
          state.headhunter
        ) {
          continue;
        }
      }
    } catch (err) {
      console.error(`Failed to evaluate employees for ${companyId}`, err);
    }
  }

  private async employeeHasMaxSkills(
    companyId: string,
    employeeId: string
  ): Promise<boolean> {
    try {
      const snap = await getDocs(
        collection(this.db, `companies/${companyId}/employees/${employeeId}/skills`)
      );
      if (snap.empty) return false;
      for (const docSnap of snap.docs) {
        const level = this.safeInt((docSnap.data() as any)?.level);
        if (level < 10) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private isRebranded(data: any): boolean {
    const logo = String(data?.logo || '').trim();
    const originalLogo = String(data?.original_logo || '').trim();
    const logoChanged = !!originalLogo && originalLogo !== logo;

    const extracted = this.theme.extractFromCompany(data);
    const normalized = this.theme.normalizeTheme(extracted);
    const defaultTheme = this.theme.normalizeTheme(this.defaultTheme);
    const themeChanged = (Object.keys(defaultTheme) as (keyof ThemeColors)[]).some(
      (key) => normalized[key] !== defaultTheme[key]
    );
    return logoChanged || themeChanged;
  }

  private isAiEmployee(data: any): boolean {
    if (!data) return false;
    if (data.aiRole === true) return true;
    const container = String(data.avatarContainer || '').toLowerCase();
    if (container === 'consultants') return true;
    const avatar = String(data.avatar || '').toLowerCase();
    return avatar.startsWith('consultants/') || avatar.startsWith('consultant_');
  }

  private async loadBadgeTemplate(): Promise<string | null> {
    if (this.badgeSvgTemplate !== null) return this.badgeSvgTemplate;
    try {
      const svg = await firstValueFrom(
        this.http.get('assets/badge.svg', { responseType: 'text' })
      );
      this.badgeSvgTemplate = svg || null;
    } catch {
      this.badgeSvgTemplate = null;
    }
    return this.badgeSvgTemplate;
  }

  private renderBadge(name: string, template: string | null): string {
    if (!template) return 'assets/badge.svg';
    const safe = this.escapeBadgeText(name);
    const svg = template.replace(/ACHIEVEMENT/g, safe);
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  private escapeBadgeText(value: string): string {
    return (value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private safeInt(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }

  private safeNumber(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
}

