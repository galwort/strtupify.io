import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UiStateService {
  private _showCompanyProfile = new BehaviorSubject<boolean>(false);
  readonly showCompanyProfile$ = this._showCompanyProfile.asObservable();


  private _companyProfileEnabled = new BehaviorSubject<boolean>(false);
  readonly companyProfileEnabled$ = this._companyProfileEnabled.asObservable();

  private _currentModule = new BehaviorSubject<'inbox' | 'roles' | 'resumes' | 'boardroom' | 'work'>('roles');
  readonly currentModule$ = this._currentModule.asObservable();

  private _workEnabled = new BehaviorSubject<boolean>(false);
  readonly workEnabled$ = this._workEnabled.asObservable();

  setShowCompanyProfile(show: boolean) {
    this._showCompanyProfile.next(show);
  }

  toggleCompanyProfile() {
    this._showCompanyProfile.next(!this._showCompanyProfile.value);
  }

  setCompanyProfileEnabled(enabled: boolean) {
    this._companyProfileEnabled.next(enabled);
  }

  setCurrentModule(m: 'inbox' | 'roles' | 'resumes' | 'boardroom' | 'work') {
    this._currentModule.next(m);
  }

  setWorkEnabled(enabled: boolean) {
    this._workEnabled.next(enabled);
  }
}
