import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UiStateService {
  private _showCompanyProfile = new BehaviorSubject<boolean>(false);
  readonly showCompanyProfile$ = this._showCompanyProfile.asObservable();


  private _companyProfileEnabled = new BehaviorSubject<boolean>(false);
  readonly companyProfileEnabled$ = this._companyProfileEnabled.asObservable();

  private _currentModule = new BehaviorSubject<'inbox' | 'roles' | 'resumes' | 'boardroom' | 'work' | 'ledger' | 'hr' | 'calendar'>('roles');
  readonly currentModule$ = this._currentModule.asObservable();

  private _workEnabled = new BehaviorSubject<boolean>(false);
  readonly workEnabled$ = this._workEnabled.asObservable();

  private _hrEnabled = new BehaviorSubject<boolean>(false);
  readonly hrEnabled$ = this._hrEnabled.asObservable();

  private _calendarEnabled = new BehaviorSubject<boolean>(false);
  readonly calendarEnabled$ = this._calendarEnabled.asObservable();

  private _inboxPreferredEmailId = new BehaviorSubject<string | null>(null);
  readonly inboxPreferredEmailId$ = this._inboxPreferredEmailId.asObservable();

  private _blockerNotice = new BehaviorSubject<string | null>(null);
  readonly blockerNotice$ = this._blockerNotice.asObservable();

  setShowCompanyProfile(show: boolean) {
    this._showCompanyProfile.next(show);
  }

  toggleCompanyProfile() {
    this._showCompanyProfile.next(!this._showCompanyProfile.value);
  }

  setCompanyProfileEnabled(enabled: boolean) {
    this._companyProfileEnabled.next(enabled);
  }

  setCurrentModule(m: 'inbox' | 'roles' | 'resumes' | 'boardroom' | 'work' | 'ledger' | 'hr' | 'calendar') {
    this._currentModule.next(m);
  }

  setWorkEnabled(enabled: boolean) {
    this._workEnabled.next(enabled);
  }

  setHrEnabled(enabled: boolean) {
    this._hrEnabled.next(enabled);
  }

  setCalendarEnabled(enabled: boolean) {
    this._calendarEnabled.next(enabled);
  }

  setInboxPreferredEmail(emailId: string | null) {
    this._inboxPreferredEmailId.next(emailId);
  }

  showBlockerNotice(message: string) {
    this._blockerNotice.next(message);
  }

  clearBlockerNotice() {
    this._blockerNotice.next(null);
  }
}
